# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read this before touching anything. STATUS.md is the cross-session handoff; update it
at the end of every session that changes state.

## What this repo is
A self-contained IBM MQ observability lab + certification harness. The contract is
`packs/ibmmq.pack.yaml` (ObservabilityPack spec v1.2, same shape as Observogram's
reference packs). `stack/` is its executable form; `harness/` proves it against a
real queue manager and writes `reports/cert-report.{json,md,html}`. First certified
live on 2026-09-16 (see STATUS.md for the run and what it took).

## Commands

Static (no Docker; this is what CI runs):
```
npm test                        # node --check on 4 entrypoints + pack schema validation (alert unit tests: promtool, below)
node tools/check-rules.mjs      # pack <-> rules <-> dashboards cross-check
npm run validate                # validate-pack + docker compose config + check-rules
npm run generate                # regenerate dashboards + stack/prometheus/rules/ibmmq.burn.yml from the pack; CI fails on a non-empty git diff
promtool check config stack/prometheus/prometheus.yml && promtool check rules stack/prometheus/rules/*.yml
ENV=lab MQ_QMGR_NAME=QM1 otelcol-contrib validate --config stack/otelcol/config.yaml   # config uses ${env:...}
amtool check-config stack/alertmanager/alertmanager.yml
```
promtool / otelcol-contrib / amtool are not npm deps; CI downloads pinned versions
(`.github/workflows/ci.yml`). Locally, run them from the pinned images instead (the
stack must be up for `exec`):
```
MSYS_NO_PATHCONV=1 docker compose run --rm --no-deps -T otel-collector validate --config=/etc/otelcol/config.yaml
MSYS_NO_PATHCONV=1 docker compose exec -T prometheus promtool check rules /etc/prometheus/rules/ibmmq.recording.yml /etc/prometheus/rules/ibmmq.alerts.yml /etc/prometheus/rules/ibmmq.burn.yml   # all three: no glob inside exec
MSYS_NO_PATHCONV=1 docker run --rm -v "C:/path/to/repo/stack/prometheus:/p:ro" --entrypoint promtool prom/prometheus:v3.14.0 test rules /p/tests/ibmmq.alerts.test.yml
```
`stack/prometheus/tests/*.yml` are promtool unit tests for the alerts whose behaviour was
once wrong live (exporter-down flapping, the two-qmgr join, pipeline-down, hung canary); CI
runs them, add a case whenever an alert expression changes.
`MSYS_NO_PATHCONV=1` matters in Git Bash on Windows: without it `/etc/...` arguments
are rewritten to `C:/Program Files/Git/etc/...` before docker sees them.

Live stack and harness:
```
npm run up | down | ps | logs   # up = docker compose up -d --build --wait (~5 min cold on Windows); down removes volumes
npm run certify                 # settle 90 s, then conformance + synthetic + all chaos experiments (~15 min) → reports/
npm run certify:quick           # --skip-chaos (~1-2 min) → reports/quick/ (never overwrites a full run's report)
node harness/run.mjs --only conformance                      # one suite: conformance | synthetic | chaos (unknown names exit 3)
node harness/run.mjs --only chaos --scenario queue-full,dlq-poison
node harness/run.mjs --settle 120 --out /tmp/run1            # wait before first check; alternate report dir
node harness/run.mjs --recover  # repair a lab left in a fault state (listener, channels, consumer, APP.BURST, DLQ)
npm run mqsc                    # runmqsc QM1 inside the container (local bindings, works with listener stopped)
curl http://127.0.0.1:29095/events   # alert-sink webhook ledger; DELETE /events clears it
```
Harness exit code: 0 PASS, 1 WARN, 2 FAIL, 3 the harness itself failed (bad flags, missing
pack, crash: a partial report with verdict ERROR is written). A requested suite that produces
no checks is FAIL, a SKIP is WARN. The chaos suite refuses to inject on a lab that still shows
a previous fault (pre-flight) and recovers the in-flight experiment on Ctrl-C; a SIGKILL (tool
timeout) cannot be caught, which is what `--recover` is for. Endpoints default to 127.0.0.1:2xxxx and
are overridable with `PROM_URL AM_URL SINK_URL LOKI_URL TEMPO_URL GRAFANA_URL
OTELCOL_URL GRAFANA_AUTH`; `PACK` picks another pack file, `COMPOSE` another compose
binary, `MQ_QMGR_NAME` another queue manager. Loki reports `/ready` only ~5 min after
it starts on this config; C1 waits up to 6 min and records time-to-ready.

## Rules
1. **Pack and stack must not drift.** Any change to an SLI, recording rule, alert or
   dashboard binding is a change in BOTH `packs/ibmmq.pack.yaml` and the matching
   file under `stack/`. `node tools/check-rules.mjs` must stay green.
2. **Dashboards and burn-rate rules are generated.** Edit `tools/gen-dashboards.mjs` or
   change the pack's `spec.policy`, then `npm run generate`; never hand-edit
   `stack/grafana/dashboards/*.json` or `stack/prometheus/rules/ibmmq.burn.yml`. When
   the generated recording rules change, paste `node tools/gen-burn-rules.mjs
   --pack-snippet` into `spec.queries.recording_rules` (check-rules compares them).
3. **No new npm dependencies in `harness/`** (Node >= 20 built-ins only). `canary/`
   may depend on `ibmmq` and `@opentelemetry/*` only.
4. **Vendored code is read-only**: `vendor/observogram/` is refreshed by copying
   from Observogram, never edited.
5. **Pinned versions everywhere** (`docker-compose.yaml`, `.env.example`,
   `canary/package.json`). Bumps are their own commit with the validation output
   (`promtool check rules`, `otelcol-contrib validate`, `docker compose config`) in
   the message.
6. **Metric names are IBM's, not ours.** `ibmmq_*` names come from
   mq-metric-samples / the container's native endpoint; if a query needs a name
   that is not in `docs/catalogue-evidence/ibmmq.md`, add the evidence first.
7. **Lab timings are lab timings.** `for:` durations, `group_wait`, poll intervals
   are tuned for a 10 s scrape so chaos MTTD reflects the pipeline. Production
   values live in the pack's prod environment overrides, not here.
8. Surgical single-concern commits; halt and ask before anything irreversible
   (deleting volumes with data someone cares about, force-pushes, rewriting reports
   that were already shared).

## How the pieces are wired

**Telemetry path.** Prometheus scrapes nothing but itself and Alertmanager
(`stack/prometheus/prometheus.yml`). Every application metric arrives by remote-write
from the OTel Collector, whose `prometheus` receiver owns the two MQ scrape jobs
`ibmmq-native` (mq:9157, qmgr process liveness, `honor_labels: true`) and
`ibmmq-exporter` (mq_prometheus as an MQ client over DEV.ADMIN.SVRCONN, queue/channel
detail). The disagreement between those two jobs is the differential diagnosis
(`IBMMQQueueManagerDown` vs `IBMMQQueueManagerUnreachable`). Logs: filelog tails docker
json logs, parses MQ's JSON console format and the apps' JSON lines, and sets
`service.name` per entry in stanza (never in OTTL, which mutates a resource shared by
the whole batch); Loki via OTLP. Traces: OTLP to Grafana Tempo. Alerts: Prometheus,
Alertmanager, then the `harness/alert-sink` webhook ledger. MTTD in the report is
alert-sink `receivedAt` minus an injection instant read from the sink's own clock.

**Why Tempo, not Jaeger.** Jaeger 2.21 removed the v1 HTTP query API and Grafana
12.4's Jaeger datasource speaks only that API, so Explore and log→trace links were
dead. Tempo is Grafana-native and the pack's declared production trace backend.

**Alerts that exist because something was silent or noisy live.** `IBMMQTelemetryPipelineDown`
(`absent_over_time(up{job="ibmmq-native"}[1m])`): if the collector dies every `up == 0`
selector is empty, not zero, and nothing else fires. `IBMMQExporterDown` has
`keep_firing_for: 1m` because mq_prometheus answers one scrape in five during a qmgr outage and
the alert flapped. `IBMMQQueueManagerUnreachable` joins `on (qmgr)` and requires the native
endpoint up for a full minute (no page during the exporter's reconnect after a restart).
`MQCanaryFailing` has a third branch for a canary hung inside an MQI call (flat counter, series
present). Log pipeline: every service logs with the compose project/service labels in the
json-file envelope; filelog drops lines from any other project on the host, names unparsed
lines after their container (never a synthetic `docker` service) and starts at the beginning
of each file (offsets persist in the `otelcol-state` volume). `ALTER TOPIC('SYSTEM.ADMIN.TOPIC')
USEDLQ(NO)`: `$SYS` publications an unscraped exporter cannot absorb are discarded, not
dead-lettered (they once put ~4 msg/s on APP.DLQ). Line endings are forced LF by
`.gitattributes` (a CRLF Dockerfile does not build).

**Timing budget (why `for:` is 10-30 s).** 10 s scrape + 10 s exporter poll + 10 s rule
eval + `for` + at most 5 s `group_wait` (2 s for SEV1) is roughly 55 s worst case
against a 60 s `expected_mttd` (150 s for message age, which must accrue 60 s first, measured 100-118 s;
90 s for experiments that also expect `MQCanaryFailing`, which by design waits for 4
consecutive failed probes = 40 s of a flat ok counter). Measured: `IBMMQQueueManagerDown`
in 40-45 s. A `rate()`-ratio form of the canary alert took 105-109 s; do not go back to it.

**Exporter metric semantics (learned live).**
- mq_prometheus exposes a publication-derived gauge only on scrapes where a `$SYS`
  publication arrived; 10 s publish vs 10 s scrape leaves ~1 scrape in 12 empty, so
  every SLI reads exporter gauges through `last_over_time(...[30s])`.
- The `$SYS` "count" elements (`ibmmq_queue_mqput_mqput1_count`, `ibmmq_queue_mqget_count`,
  …) are per-interval deltas, not counters: `overrideCType: false`, and rates are
  `sum_over_time(x[2m]) / 120`, never `rate()`. `ibmmq_channel_messages`, `_bytes_sent` and
  `_bytes_rcvd` are deltas too (raw samples 99/50/99/50 on a steady channel; `rate()` showed
  half the real throughput), so the same estimator applies (`perSec()` in gen-dashboards).
- The native endpoint's counters already end in `_total` (`ibmmq_qmgr_commit_total`,
  `ibmmq_qmgr_destructive_get_total`); the collector appends `_total` only to OTLP
  counters such as the canary's `mq_canary_attempts_total`.
- A manual `curl` of the exporter's `/metrics` consumes the publications the next
  Prometheus scrape needed. Judge the exporter from Prometheus, not from curls.

**How check-rules and the harness bind pack to stack** (`tools/check-rules.mjs`,
`harness/lib/pack.mjs`):
- Recording rules: pack `spec.queries.recording_rules[].name` must exist verbatim as a
  `record:`. Convention `ibmmq:<sli>:<agg>_<window>`.
- Alerts: pack references come in two spellings, `expected_alerts` (PascalCase
  alertname) and `remediation[].trigger` (`alert:kebab-case`). Both are matched by
  stripping `alert:`, dashes and underscores and lowercasing, so
  `alert:ibmmq-queue-manager-down` matches `IBMMQQueueManagerDown`.
- Dashboards: for each pack dashboard with `source: file://...`, the JSON `uid` must
  equal the pack `id`, and each `panel_bindings[].binds_to` must appear as some panel's
  `description: "binds_to: <value>"` (the `binds` option in `gen-dashboards.mjs`).
  A dashboard with `template:` and no `source` is skipped (reported as template-bound
  by conformance C7). `ibmmq-unified` is laid out by `flow()` (add panels in reading
  order, never by coordinates). After changing any dashboard run `npm run
  verify:dashboards` against the live stack: it executes every Prometheus/Loki/Tempo
  target of every panel (instant and range), lists the ones that error or return nothing,
  flags targets where only an `or vector(0)` fallback answers ("MASKED": the metric name
  itself is unverified) and treats Loki streams carrying `__error__` as errors. It refuses
  to run while a symptom alert is firing unless `--allow-firing` is given. Burn-rate stat
  colours come from each SLO's policy factors (`burnThresholds()`), not a fixed 6×/14×.
- Chaos: each `validation.chaos_experiments[].id` needs an entry in the `faults` map in
  `harness/checks/chaos.mjs` (inject + recover), otherwise it is SKIP.
  `fault.duration` is the hold time, `expected_mttd` the target, and
  `steady_state_hypothesis: ref:slos.<id>` resolves to the SLI sampled before/during/after.
  `listener-stopped` must force-stop both SVRCONN channels as well: STOP LISTENER alone
  leaves established client conversations working and nothing is detected.
- Alert labels: every rule carries `severity: SEV1|SEV2|SEV3`, `pack: ibmmq` and
  `sli: <id>` (`slo: <id>` for burn-rate rules). Synthetic S5, the dashboard
  alert annotation and the "Firing pack alerts" panel all query `ALERTS{pack="ibmmq"}`,
  so an alert without that label is invisible to them.
- Policy: every `spec.policy.burn_rate_alerts[].windows[]` entry must exist as the alert
  `<slo>_burn_<factor>x_<short>_<long>` (Observogram compiler naming, labels
  `slo/sli/service/burn_rate/window_short/window_long`) and every forecast as
  `<slo>_forecast_breach`; `tools/gen-burn-rules.mjs` emits them, check-rules and C5
  require them. S5 grades symptom alerts, S6 burn-rate alerts (fast window FAIL, slow
  1h/6h window WARN: those legitimately keep burning for hours after any incident).
  The generator's PromQL deviates from the compiler on purpose (header + evidence §8):
  error ratio = bad samples / expected samples (missing time counts as good), the short
  window needs ≥ 2 bad samples, forecasts regress the 1h burn and need 2h above 1×, the
  forecast horizon is capped at the 1 d regression window (the annotation says which horizon
  was evaluated) and forecast severity follows `on_projected_breach`. All were measured
  failures of the naive forms on this stack; do not "simplify" back.
- check-rules resolves every `ref:slis.<id>` recording rule to the SLI's query (threshold) or
  good/total selectors (ratio) and compares it with the stack rule: a stack edit that drifts
  from the pack SLI fails there. Every alert rule must carry `severity/pack/sli` and an
  existing `runbook:` file.
- Conformance C6 has a hard-coded list of required metric families in
  `harness/checks/conformance.mjs`; changing which metrics an SLI depends on means
  updating that list too.

**YAML parser limits.** The pack and the Prometheus rule files are parsed by the
vendored `mini-yaml.mjs`: no anchors/aliases, no chomping indicators (`|-`), no tags,
no complex keys. `docker-compose.yaml` is exempt (docker parses it) and does use anchors.

**MQ objects** live in `stack/mq/20-observability.mqsc` (auto-run at qmgr start,
idempotent, ASCII only — a single bad attribute name there stops `strmqm` with
AMQ5776E; check with `runmqsc -v QM1 < file` inside the image). Things the harness
depends on: `APP.BURST` has MAXDEPTH(200) so 200 `amqsput`s fill it exactly
(queue-full), `APP.DLQ` is the qmgr DEADQ (dlq-poison), the listener is
`SYSTEM.LISTENER.TCP.1` (listener-stopped), `MONQ(HIGH)` is what makes
`ibmmq_queue_oldest_message_age` exist, and the `app` user is authorised on `APP.**`
only. Dev credentials in `stack/mq/secrets/` are committed on purpose (loopback-only lab).

**Canary** (`canary/src/`, one image, `MODE=canary|producer|consumer`): `otel.mjs`
must be imported before `mq.mjs`, because the `ibmmq` module only propagates
`traceparent` through message properties if `@opentelemetry/api` is already loaded.
The consumer keeps its CONSUMER span active around the GET so the module attaches the
producer link; conformance C9 counts consumer `receive` spans in Tempo whose link points
at another trace. Every GET passes `MQGMO_NO_PROPERTIES`: otherwise the trace-context
properties arrive as an MQRFH2 header prepended to the body (Format `MQHRF2`).

**Build on Windows.** Compose v5 delegates builds to buildx bake, which on Windows
cannot use a git-URL build context; `stack/mq-exporter/Dockerfile` therefore clones
IBM's repo at the pinned tag inside its builder stage. Loki and Tempo images are
distroless (no sh/wget): no compose healthchecks, the harness probes `/ready`.

**Live-run gotchas.** Never leave a `docker compose run` container behind: a
mq_prometheus instance nobody scrapes fills its temporary reply queues to MAXDEPTH (its
publications are now discarded rather than dead-lettered, but it still wastes the qmgr's
time). A background command that ends with `tail` reports `tail`'s exit code, not the
command's. A harness run killed by a tool timeout leaves its fault injected: run
`node harness/run.mjs --recover` before anything else. Bind-mounted configs (Loki, Tempo,
Alertmanager, the collector, Prometheus rules) are read at process start only, and compose
does not recreate a container because a mounted file changed: after editing one,
`docker compose restart <service>` (Prometheus rules: `curl -X POST :29090/-/reload`),
otherwise you certify the old process.

## Adding things
- **New alert**: rule in `stack/prometheus/rules/ibmmq.alerts.yml` with the three
  labels; if the pack should reference it, add it to `expected_alerts` and/or
  `remediation`, write the `runbooks/*.md` and point the rule's `runbook:` annotation
  at it; run check-rules.
- **New chaos experiment**: pack entry + `faults[<id>]` in `harness/checks/chaos.mjs`
  + any MQ object it needs in the MQSC file; expected alerts must already exist.
- **New SLI/SLO**: pack `slis[]` + `slos[]` + a `policy.burn_rate_alerts` entry (two
  windows) + recording rule (both files; threshold SLIs need a `ref:slis.<id>` recording
  rule because the burn generator reads the SLI from it) + `npm run generate` + the
  `--pack-snippet` paste + dashboard panel with `binds` + `panel_bindings` + C6 family
  list if it introduces a metric + evidence in `docs/catalogue-evidence/ibmmq.md` if the
  metric name is new (the live inventory is `docs/catalogue-evidence/ibmmq-live-metrics-2026-09-16.md`).

## Validation before every push
```
npm test && node tools/check-rules.mjs && docker compose config --quiet
promtool check rules stack/prometheus/rules/*.yml && promtool test rules stack/prometheus/tests/*.yml
ENV=lab MQ_QMGR_NAME=QM1 otelcol-contrib validate --config stack/otelcol/config.yaml
amtool check-config stack/alertmanager/alertmanager.yml
npm run generate && git diff --exit-code stack/grafana/dashboards stack/prometheus/rules
```
Then, when the change touches anything under `stack/`, `canary/` or `harness/`: restart or
recreate the services whose files changed, `npm run verify:dashboards` for dashboard changes,
`npm run certify:quick` against the live stack, and `npm run certify` for chaos changes.

## Where things are
See README.md "Layout", "Ports" and "Versions". Ports are all 127.0.0.1:2xxxx (never
collide with Observogram's 1xxxx validation stacks). Compose project name is `mq-obs`.
