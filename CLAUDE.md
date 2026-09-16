# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read this before touching anything. STATUS.md is the cross-session handoff; update it
at the end of every session that changes state.

## What this repo is
A self-contained IBM MQ observability lab + certification harness. The contract is
`packs/ibmmq.pack.yaml` (ObservabilityPack spec v1.2, same shape as Observogram's
reference packs). `stack/` is its executable form; `harness/` proves it against a
real queue manager and writes `reports/cert-report.{json,md,html}`.

## Commands

Static (no Docker; this is what CI runs):
```
npm test                        # node --check on 3 entrypoints + pack schema validation (there are no unit tests)
node tools/check-rules.mjs      # pack <-> rules <-> dashboards cross-check
npm run validate                # validate-pack + docker compose config + check-rules
npm run dashboards              # regenerate stack/grafana/dashboards/*.json; CI fails on a non-empty git diff
promtool check config stack/prometheus/prometheus.yml && promtool check rules stack/prometheus/rules/*.yml
ENV=lab MQ_QMGR_NAME=QM1 otelcol-contrib validate --config stack/otelcol/config.yaml   # config uses ${env:...}
amtool check-config stack/alertmanager/alertmanager.yml
```
promtool / otelcol-contrib / amtool are not npm deps; CI downloads pinned versions
(`.github/workflows/ci.yml`). Locally drop them in the git-ignored `.tools/`.

Live stack and harness:
```
npm run up | down | ps | logs   # up = docker compose up -d --build --wait (3-5 min first time); down removes volumes
npm run certify                 # settle 90 s, then conformance + synthetic + all chaos experiments (~20 min)
npm run certify:quick           # --skip-chaos (~1 min)
node harness/run.mjs --only conformance                      # one suite: conformance | synthetic | chaos
node harness/run.mjs --only chaos --scenario queue-full,dlq-poison
node harness/run.mjs --settle 120 --out /tmp/run1            # wait before first check; alternate report dir
npm run mqsc                    # runmqsc QM1 inside the container (local bindings, works with listener stopped)
curl http://127.0.0.1:29095/events   # alert-sink webhook ledger; DELETE /events clears it
```
Harness exit code: 0 PASS, 1 WARN, 2 FAIL. Endpoints default to 127.0.0.1:2xxxx and
are overridable with `PROM_URL AM_URL SINK_URL LOKI_URL JAEGER_URL GRAFANA_URL
OTELCOL_URL GRAFANA_AUTH`; `PACK` picks another pack file, `COMPOSE` another compose
binary, `MQ_QMGR_NAME` another queue manager.

## Rules
1. **Pack and stack must not drift.** Any change to an SLI, recording rule, alert or
   dashboard binding is a change in BOTH `packs/ibmmq.pack.yaml` and the matching
   file under `stack/`. `node tools/check-rules.mjs` must stay green.
2. **Dashboards are generated.** Edit `tools/gen-dashboards.mjs`, run `npm run
   dashboards`; never hand-edit `stack/grafana/dashboards/*.json`.
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
`ibmmq-native` (mq:9157, qmgr process liveness) and `ibmmq-exporter` (mq_prometheus as
an MQ client over DEV.ADMIN.SVRCONN, queue/channel detail). The disagreement between
those two jobs is the differential diagnosis (`IBMMQQueueManagerDown` vs
`IBMMQQueueManagerUnreachable`). Logs: filelog tails docker json logs, parses MQ's JSON
console format, sets `service.name=ibmmq`, ships to Loki via OTLP. Traces: OTLP to
Jaeger. Alerts: Prometheus, Alertmanager, then the `harness/alert-sink` webhook ledger.
MTTD in the report is alert-sink `receivedAt` minus injection wall clock, never
Alertmanager `startsAt`.

**Timing budget (why `for:` is 10-30 s).** 10 s scrape + 10 s exporter poll + 10 s rule
eval + `for` + at most 5 s `group_wait` (2 s for SEV1) is roughly 55 s worst case
against a 60 s `expected_mttd` (120 s for message age, which must accrue 60 s first).
Raising any one of these breaks chaos PASS.

**Canary metric names cross a renaming boundary.** The canary emits OTel instruments
`mq.canary.attempts` and `mq.canary.roundtrip.duration` (unit `s`); the collector's
remote-write exporter has `add_metric_suffixes: true`, so PromQL sees
`mq_canary_attempts_total` and `mq_canary_roundtrip_duration_seconds_bucket`.

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
  by conformance C7).
- Chaos: each `validation.chaos_experiments[].id` needs an entry in the `faults` map in
  `harness/checks/chaos.mjs` (inject + recover), otherwise it is SKIP.
  `fault.duration` is the hold time, `expected_mttd` the target, and
  `steady_state_hypothesis: ref:slos.<id>` resolves to the SLI sampled before/during/after.
- Alert labels: every rule carries `severity: SEV1|SEV2|SEV3`, `pack: ibmmq` and
  `sli: <id>` (`slo: <id>` for burn-rate rules). Synthetic S5, the dashboard
  alert annotation and the "Firing pack alerts" panel all query `ALERTS{pack="ibmmq"}`,
  so an alert without that label is invisible to them.
- Conformance C6 has a hard-coded list of required metric families in
  `harness/checks/conformance.mjs`; changing which metrics an SLI depends on means
  updating that list too.

**YAML parser limits.** The pack and the Prometheus rule files are parsed by the
vendored `mini-yaml.mjs`: no anchors/aliases, no chomping indicators (`|-`), no tags,
no complex keys. `docker-compose.yaml` is exempt (docker parses it) and does use anchors.

**MQ objects** live in `stack/mq/20-observability.mqsc` (auto-run at qmgr start,
idempotent). Things the harness depends on: `APP.BURST` has MAXDEPTH(200) so 200
`amqsput`s fill it exactly (queue-full), `APP.DLQ` is the qmgr DEADQ (dlq-poison), the
listener is `SYSTEM.LISTENER.TCP.1` (listener-stopped), `MONQ(HIGH)` is what makes
`ibmmq_queue_oldest_message_age` exist, and the `app` user is authorised on `APP.**`
only. Dev credentials in `stack/mq/secrets/` are committed on purpose (loopback-only lab).

**Canary** (`canary/src/`, one image, `MODE=canary|producer|consumer`): `otel.mjs`
must be imported before `mq.mjs`, because the `ibmmq` module only propagates
`traceparent` through message properties if `@opentelemetry/api` is already loaded.
The consumer keeps its CONSUMER span active around the GET so the module attaches the
producer link; conformance C9 counts those `FOLLOWS_FROM` references in Jaeger.

## Adding things
- **New alert**: rule in `stack/prometheus/rules/ibmmq.alerts.yml` with the three
  labels; if the pack should reference it, add it to `expected_alerts` and/or
  `remediation`, write the `runbooks/*.md` and point the rule's `runbook:` annotation
  at it; run check-rules.
- **New chaos experiment**: pack entry + `faults[<id>]` in `harness/checks/chaos.mjs`
  + any MQ object it needs in the MQSC file; expected alerts must already exist.
- **New SLI**: pack `slis[]` + recording rule (both files) + dashboard panel with
  `binds` + `panel_bindings` + C6 family list if it introduces a metric + evidence in
  `docs/catalogue-evidence/ibmmq.md` if the metric name is new.

## Validation before every push
```
npm test && node tools/check-rules.mjs && docker compose config --quiet
promtool check rules stack/prometheus/rules/*.yml
ENV=lab MQ_QMGR_NAME=QM1 otelcol-contrib validate --config stack/otelcol/config.yaml
amtool check-config stack/alertmanager/alertmanager.yml
npm run dashboards && git diff --exit-code stack/grafana/dashboards
```

## Where things are
See README.md "Layout", "Ports" and "Versions". Ports are all 127.0.0.1:2xxxx (never
collide with Observogram's 1xxxx validation stacks). Compose project name is `mq-obs`.
