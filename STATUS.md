# STATUS

## Current state (rewritten each session; the dated log below is history)

- **Branches.** `main` = PR #6 merge pending via PR #7 (`develop` → `main`, open, Auto-fix on);
  `develop` carries the vendored Observogram generators. Tag `v0.2.0` = PR #3 merge.
- **Lab.** Up on Nitro5 since 2026-09-16 21:08Z, running the regenerated burn rules
  (canary ratio over probes that happened); last `certify:quick` PASS 16/16 after that reload;
  Grafana holds a "Reference packs (generated)" folder with 15 imported boards from
  Observogram's three reference packs (delete when done).
- **Generators.** Live in Observogram (`tools/lib/dashboards/`, `tools/lib/burn-rules.mjs`,
  merged: PR #87 library, PR #88 unified board for every pack); this repo vendors them
  (`vendor/observogram/SOURCES.json` records commit and hash per file, `tools/check-pins.mjs`
  verifies) and keeps the MQ boards in `tools/dashboards/ibmmq.mjs`.
- **In flight (Observogram).** `codex/compile-burn-rules`: wiring `compilePrometheusRules` to the
  burn-rules library (orchestrated job, golden-gated). Fleet generator design
  (inventory-driven `gen-site`, `--env prod`, `--profile non-container`, degraded single-vantage
  alert set) in progress; blocked only on the registry format (`50974-mq-registry`, not
  reachable from here).
- **Open feedback, in priority order.** (1) fleet/site generator from an inventory; (2) prod
  overrides applied by the generators; (3) non-container profile (C6 family, 16 native panels);
  (4) canary TLS/CCDT; (5) degraded mode for single-vantage fleets; (6) RDQM signal and
  failover experiment; (7) Helm chart defaults and scaffold gates (repos not available here);
  (8) sustainability: pin drift (done: `tools/check-pins.mjs` in `npm test` and CI), vendor
  staleness (done), STATUS structure (this block), identity (`REPO_URL` override done).

## 2026-09-17 (late afternoon) — sustainability items from the fleet feedback

`tools/check-pins.mjs`: Compose defaults, `.env.example`, the CI tool versions, the two
Dockerfiles and the README must name the same versions (they did; CI now proves it every push),
and every vendored file must equal the file at the commit `vendor/observogram/SOURCES.json`
records (network) and match its stored hash (offline, in `npm test`); upstream `develop` moving
past the commit is a warning, `--strict` makes it fail. `generic.mjs` re-vendored at bc36ad7
(unified board for every pack); MQ boards byte-identical. `REPO_URL` overrides the runbook link
base on the boards for forks. Two workflows in Observogram worktrees are running the compiler
wiring and the fleet-generator design; results land in the next entry.

## 2026-09-17 (afternoon) — the generators become Observogram's library; run for three reference packs

**Ask:** generalise `gen-dashboards.mjs` so other components (Grafana, Prometheus, ...) get
boards with the pack layers as the template; run it for Observogram's grafana, kafka and
prometheus reference packs and validate the results; the functionality must live in
Observogram and be used from here.

**Done in Observogram** (branch `codex/pack-dashboards`, worktree
`Observogram/.claude/worktrees/pack-dashboards`, PR into `develop`): `tools/lib/dashboards/lib.mjs`
(visual system, panel factories, flow layout, pack-derived blocks), `tools/lib/dashboards/generic.mjs`
(one board per `dashboards[]` entry in the pack's section order, template entries become real
boards, every binding must be bound), `tools/lib/burn-rules.mjs` (the corrected burn compiler as
a library: counter SLIs divide by the events that happened, filter comparisons in state SLIs
rewritten to `== bool` with a warning, step from the pack's scrape_interval, lab or prod `for:`),
CLIs `gen-dashboards.mjs` / `gen-burn-rules.mjs` (`--pack`, `--out-dir`, `--module`),
`test-gen-pack.mjs` in `npm test` (40/40, lint 0 errors), and the generated output for the
three packs under `reference-packs/dashboards` and `reference-packs/rules` with a README of
findings.

**Done here:** the three library files vendored under `vendor/observogram/lib/` (rule 4);
`tools/gen-dashboards.mjs` and `tools/gen-burn-rules.mjs` are thin wrappers;
`tools/dashboards/ibmmq.mjs` holds the MQ boards; `PACK` / `--pack` honoured by both generators
and by check-rules, so the guide's site-pack step (7.1) is now true. One behaviour change: the
canary's error ratio divides by the probes that happened (`clamp_min(increase(total), 1)`)
instead of the expected count; pack snippet, evidence §8 and CLAUDE.md updated.

**Verified:** MQ boards byte-identical through the vendored library (`git diff` empty); the
burn file changed only in the four canary expressions; check-rules green; promtool check on
all rule files and the alert unit tests SUCCESS; Prometheus reloaded; `certify:quick` after
the reload (result in the session's final report). Reference packs: promtool on the three burn
files and on all 194 panel expressions; Grafana 12.4.11 imported 12/12 boards (folder
"Reference packs (generated)", still present); the prometheus pack ran live for two minutes
with its recording rules loaded: 48 rules healthy, 9 of 11 pack rules producing, 37 panel
targets with data, 0 errors, the two empty SLIs name histograms that do not exist.
**Findings about the packs** (README in Observogram): grafana names 7 metrics Grafana 12.4.11
does not expose; prometheus' two latency SLIs use `_bucket` names of a gauge and a summary;
kafka and prometheus state SLIs use filter comparisons; all three expect alert names no
compiler emits and declare a hand-written `burn_1h` rule without an `slo` label.

## 2026-09-17 (midday) — architecture at four levels, and the guide for existing queue managers

**Ask:** an architecture document with several levels of detail, and, more importantly, a
guide to instrument an existing MQ or RDQM cluster so it produces the same metrics and can be
monitored like the reference system.

**Done (branch `docs/architecture-and-onboarding`, PR into `develop`):**
- `docs/ARCHITECTURE.md` rewritten: level 0 one paragraph; level 1 the twelve services with
  images, ports, configs and a component map; level 2 the seven planes (contract, metrics,
  logs, traces, alerting, synthetic, certification) and the dashboards, each with the files
  that implement it and the check that proves it; level 3 every decision with its evidence;
  level 4 operating and changing the lab. Four Mermaid diagrams.
- `docs/INSTRUMENTING-EXISTING-MQ.md`: the metric and label contract; both vantage points
  without the container's native endpoint (mq_prometheus with local bindings as an MQ SERVICE
  that follows the queue manager, scraped through the RDQM floating IP, plus a client instance
  over a dedicated SVRCONN); queue manager MQSC; a least-privilege monitoring identity; JSON
  error logs from `qm.ini`; exporter configs; collector and Prometheus scrape configs; the
  file-based log agent; the canary; the site-pack workflow for queue names; production
  timings; RDQM (what moves with the queue manager, failover as seen by the pack, HA state as
  textfile metrics); verification; a gaps table. README points at both.

**Verified live (MQ 10.0.0.5, mq_prometheus v6.0.0):** the exporter's least-privilege
authority set, by running it as the non-admin `app` user over `DEV.APP.SVRCONN` across six
rounds (grant, run, scrape twice, compare with the 175-family inventory): qmgr CONNECT/INQ/DSP,
`SYSTEM.ADMIN.COMMAND.QUEUE` PUT, `SYSTEM.DEFAULT.MODEL.QUEUE` GET/PUT/INQ (without PUT the
`$SYS` subscriptions fail silently and only object-status metrics appear; without INQ the open
fails 2035), `SYSTEM.ADMIN.TOPIC` SUB, DSP on monitored queues and channels (without channel
DSP: 172 families, 5 of 13 channel series). Every grant was reverted and the `app` records
compared with their original state; no test container left. A `queues: ["!*"]` list gives a
queue-manager-only instance (112 families, 0 queue/channel series). The guide's 27 MQSC
statements pass `runmqsc -v`; both collector configs pass `otelcol validate` 0.161.0; the
Prometheus config passes promtool 3.14; the Alertmanager config passes amtool 0.34; all five
Mermaid diagrams parse with mermaid 11; every metric name in both documents exists in the
inventory or the live TSDB; every relative link resolves. Not verified: anything on a real
RDQM group (none available); those statements cite IBM's documentation and say so.

**Gaps the guide records for a non-container deployment** (each with its intended fix):
C6 requires the container-only `ibmmq_qmgr_commit_total`; 16 unified-board targets read
native `_total` counters; the canary has no TLS/CCDT; the lab's queue names sit in the pack,
the recording rules, synthetic S4 and one panel; the generator and SLI windows assume a 10 s
scrape; the prod `for:`/`group_wait` overrides are declared, not applied; no RDQM state signal
or failover experiment.

## 2026-09-17 (morning) — crash check, PR #3, PR #2 corrected, upstream issues drafted

**What happened overnight.** The 00:14Z session ended normally (its final report is in the
transcript, work committed and pushed, CI green). The laptop entered standby 07:22-07:45Z
(Windows Kernel-Power 42/107, clock jumped 23 min), which froze the lab: a 23 min gap in every
series, `MQCanaryFailing` firing for 10 s on resume while the canary reconnected (a
firing+resolved pair in the alert-sink ledger), and the desktop app restarting, which looked
like a session crash. Nothing was lost and the lab had no fault.

**Done:**
- PR #2 merged 2026-09-16 23:38Z at `81f23da` (20 commits). The three commits pushed after it
  (`2ebd336` cert-metrics, `97fb313` dashboards, `5df9995` docs) were never in it: they are
  PR #3 (`develop` → `main`, https://github.com/MoebiusX/mq-observability-pack/pull/3), CI green.
- `fix(alert-sink)` `dbe23f5`, in PR #3: the ledger key separator in `server.mjs` was a literal
  NUL byte typed into the source, so git treated the file as binary (no diff, no blame). Now the
  escape sequence for U+0000: same string, verified with node --check, npm test and the two expressions
  executed side by side. The running sink was not rebuilt; not needed.
- PR #2's description: the "commits 21-23" section it never contained now points at PR #3.
- Four issues against Observogram's `tools/lib/compile.mjs` (permalinks at `9197423`) drafted
  with the measured numbers: since-start averaging on partly filled windows, single-sample SEV1
  re-fires, forecast echo with fixed SEV3 and `method` ignored, one-directional recording-rule
  checks (conformance name substring, drift counts). **Not filed**: this session's auto mode
  blocks writes to external systems; the drafts and the `gh issue create` commands were handed
  to Carlos in the session. If lost, re-derive from evidence §8 and the generator header.

**Lab:** up since 2026-09-16 21:08Z, 0 container restarts, nothing firing, the sink still
serves the 21:16Z full run's certification metrics. Left up for the PR #3 dashboard review.

## 2026-09-17 (early) — dashboards restyled and reorganised around the pack; MTTD/MTTR on the boards

**Ask:** professional, premium-looking dashboards that show what matters (MTTD, MTTR, SLOs)
clearly, organised by the pack's structure the way the Kafka reference pack is.

**Done (`feat(dashboards)` + `feat(cert-metrics)`):**
- Unified board now follows the pack's section order: §1-2 SLIs and SLOs (tiles with
  sparklines, error-budget burn per SLO as a bar gauge coloured by that SLO's own policy
  factors, fast/slow burn curves) → §10 validation (last certification verdict, when, MTTD
  p50/p95 and MTTR p50/p95 against the pack baselines, every expected alert's detection time
  against its `expected_mttd`, resolution after recovery, checks per suite; then the synthetic
  canary/orders flow) → §7-8 policy and alerting (state timelines of pending/firing, firing
  table with severity colouring) → §9 remediation (table generated from the pack: trigger,
  runbook link, declared automation and guardrails) → signals (availability timeline, queues
  with headroom bars, channels timeline, resource gauges) → §3-5 pipelines/storage/queries →
  logs and traces. Header banner with cross-board links; rows without emoji; annotations only
  for symptom alerts.
- Visual system in the generator: one palette, value-coloured stats (solid tiles only for
  states), smooth gradient lines with nulls bridged across exporter gaps, dashed SLO
  threshold lines, table legends with last/max, semantic series colours. State timelines
  need `color.mode: fixed` on Grafana 12 (thresholds mode ignored the mapping colours —
  found with a side-by-side test dashboard, since deleted).
- MTTD and MTTR as metrics: the harness POSTs each run's summary to the alert-sink
  (`/results`), the sink exposes `mq_cert_*` at `/metrics`, the collector scrapes it as job
  `certification` (pack `pipelines` updated), `node harness/run.mjs --publish <report>`
  re-publishes after a sink restart. The report now also carries `mttr` quantiles.
- Pack bindings moved from `description: "binds_to: …"` to a `pack.binds_to` array per
  panel (check-rules reads both), so descriptions are human text shown on hover.

**Verification:** check-rules green (4 dashboards), verify-dashboards 0 errors on all four
boards (empties are alert-state series while nothing fires, masked ones are `or vector(0)`
counters), the last full run's MTTD p50 54.7 s / p95 109.8 s and MTTR p50 34.6 s / p95 39.7 s
visible on the board from Prometheus, screenshots checked at 1600 px.

## 2026-09-16 (night) — adversarial review of the whole day's work, remediated

**What happened:** eight independent read-only reviewers (rules, burn generator, harness,
dashboards, pipeline, canary, docs, security) went over everything on `develop` since the
scaffold, each finding backed by a live observation. Accepted: 9 HIGH, 24 MEDIUM, a dozen LOW
fixed in passing. The full list, evidence and fixes: `docs/reviews/2026-09-16-adversarial-review.md`.
One reviewer ran the chaos suite against instructions and was killed mid-hold, leaving the
listener and channels stopped for 2.5 min — which became the live evidence for the harness's
biggest gap (no recovery on interruption).

**Fixed (single-concern commits, read them in order):**
- repo: `.gitattributes` forces LF — a fresh Windows clone (autocrlf=true) could not build the
  exporter (CRLF Dockerfile fails at the first backslash continuation; verified with a clone).
- harness: recovery in `finally` and on SIGINT/SIGTERM, `--recover`, pre-flight refusing a
  dirty lab, exit 3 on crash/bad flags, FAIL on empty suites, SKIP = WARN, hypothesis SLI
  sampled as the worst series and graded (holds / violated / holds), fingerprint-matched
  resolution, host-clock hold, `sinkNow()` no longer falls back to the host clock, runmqsc
  failures detected, S4 grades what it prints, evidence (firedAt/resolvedAt/fingerprints/ledger)
  in the JSON, `reports/quick/` for partial runs, Markdown cells escaped, alert-sink caps.
- rules: `IBMMQTelemetryPipelineDown` (collector death made every `up == 0` selector empty),
  `keep_firing_for: 1m` on `IBMMQExporterDown` (flapped every ~50 s during outages),
  `IBMMQQueueManagerUnreachable` joins `on (qmgr)` and needs native up for 1 min, hung-canary
  branch in `MQCanaryFailing`, headroom denominator gap-bridged, canary p99 on `result="ok"`,
  forecast horizon annotated honestly and severity from `on_projected_breach`; promtool unit
  tests for all of them (`stack/prometheus/tests/`), run in CI.
- dashboards: channel messages/bytes were `rate()` on deltas (half the truth) → `sum_over_time/120`;
  overview qmgr log panel dropped `| json` (errored on 96 % of lines); burn stat colours from
  each SLO's policy factors; `service` variable from Loki with All = the four MQ services;
  eighth SLO on the burn board; verify-dashboards now checks range queries, `__error__`
  streams, `or vector(0)` masking, template variables, and refuses to run mid-incident.
- pipeline: json-file logging with compose labels on every service, filelog keeps only this
  project (proved with an out-of-project probe container), names unparsed lines after their
  container, `start_at: beginning` (startup lines now in Loki), `restart: unless-stopped`
  everywhere, log rotation, `mem_limit` on the apps, `ALTER TOPIC('SYSTEM.ADMIN.TOPIC') USEDLQ(NO)`
  (exporter overflow no longer dead-letters; inherited status verified with TPSTATUS).
- canary: connection released when OPEN fails, no busy loop on GET errors, oversized messages
  discarded, canary messages expire after 30 s, session recycled every N messages (the
  consumer's native heap grew ~1 KB per GET), timing starts after connect, clean MQDISC on
  SIGTERM, `auth_failed` classification.
- supply chain: base images by digest, exporter source tag pinned to its commit, IBM client
  tarball SHA-256 verified in the build, exporter runs as uid 1001, `MQIJS_VRM` pinned; CI has
  `permissions: contents: read`, SHA-pinned actions and checksum-verified downloads.
- tools: check-rules resolves `ref:` recording rules to their SLI and requires labels/runbooks.

**Verification.** Stack recreated 21:02Z with every change above (new images, compose
logging/restart/limits, collector config, MQSC). Full `npm run certify` 21:05-21:17Z (11.7 min
incl. 60 s settle): **PASS**, 10/10 conformance, 6/6 synthetic (S6 clean), 5/5 chaos, MTTD
p50 54.7 s / p95 109.8 s. Every experiment now also shows the hypothesis SLI holding /
violated / holding (e.g. queue-full 0.00 / 1.00 / 0.00 against 0.8, consumer-stall 0 / 137 s / 0
against 60 s), fingerprints and the ledger are in the JSON. Per alert: Down 44.7 s,
CanaryFailing 54.7 / 58.0 s, Unreachable 68.0 s (was 57-60 s: the new 1 min native-up guard
costs ~10 s, budget 90 s), DepthHigh 47.5 s, Full 37.5 s, AgeHigh 109.8 s, DLQ 49.4 s;
resolutions 18-40 s. `reports/cert-report.*` holds this run. Also verified live: promtool unit
tests SUCCESS, an out-of-project container's log line is not ingested, startup lines are,
Loki service names are container names, exporter runs as uid 1001, `USEDLQ(NO)` survives a
qmgr restart, `up{}` carries `service="ibmmq"`, verify-dashboards 0 errors on all four boards.
**Consumer memory (H8), measured tonight.** `/proc/1/smaps` `[heap]` of the orders consumer:
with the ibmmq module's OTel hook on, +1080 kB over 950 GETs (~1.1 KB/GET), monotonic through
two connection recycles (reconnecting every 1000 messages released nothing); with
`MQIJS_NOOTEL=1`, +770 kB over ~1900 GETs (~0.4 KB/GET) from a fresh process, so the module's
per-GET OTel path (message handle + MQINQMP) is most of it but not all. The reviewer's
10-minute sample on a 4-hour-old process gave the same ~1 KB/GET. Not fixed here: it is in
the client library, to be reported upstream (ibmmq 2.1.9 / MQ client 10.0.0.0). Bounded
instead: `mem_limit: 512m` + `restart: unless-stopped` on the three app services, so at
5 msg/s the consumer container recycles itself roughly once a day instead of exhausting the
host; `CONSUMER_RECYCLE_EVERY` stays available but is off by default.

## 2026-09-16 (evening) — parity with the Kafka reference pack: spec.policy compiled to rules

**Goal:** make this pack the working equivalent of Observogram's
`reference-packs/kafka.pack.yaml`. Section-by-section comparison: every Kafka section
has an MQ counterpart and MQ is a superset (8 SLIs/SLOs vs 6, lab environment, harness).
The one thing the pack declared and the stack did not implement was `spec.policy`:
14 burn-rate windows over 7 SLOs and 3 forecasts, versus 2 hand-written burn alerts.
The spec maps `policy.burn_rate_alerts` to Prometheus alerting rules and the Kafka
pack's chaos experiments certify on exactly those alerts.

**Done (commit `feat(policy)`):**
- `tools/gen-burn-rules.mjs` generates `stack/prometheus/rules/ibmmq.burn.yml` from the
  pack: 14 burn-rate alerts + 3 forecast alerts + 21 error-budget recording rules,
  named/labelled as Observogram's compiler emits them. Extensions documented in evidence
  §8 (state-style ratio SLIs via `avg_over_time`, threshold SLIs via breach fraction).
- `ibmmq-slo-burn` is a real provisioned dashboard (was a platform template ref).
- check-rules proves policy coverage and pack/stack expression equality; C5 requires the
  policy alerts (24 referenced); S5 grades symptom alerts, new S6 grades burn alerts.
- Pack version 0.2.0. `npm run generate` regenerates both generated artefacts; CI diffs.
- Adversarial review of the generated PromQL on the live stack (14 agents) confirmed
  four defects, all fixed in the generator (commit `fix(policy)`): error ratios now count
  bad samples over the *expected* sample count (a fresh TSDB made every 6 h window a
  since-start average), the short window needs ≥ 2 bad samples (one bad probe re-fired
  SEV1 for an hour after any incident), forecasts regress the sustained 1 h burn instead
  of echoing the last outage, and check-rules compares generated recording rules
  symmetrically. The four deviations from Observogram's compiler are documented in
  evidence §8 and the generator header.
- **Full certification 17:44-17:56Z with the policy layer: PASS** — 10/10 conformance,
  6/6 synthetic (S6 new), 5/5 chaos, MTTD p50 56.5 s / p95 110 s. The burn-rate alerts
  fired for real during the experiments (`qmgr_process_up_99_9_burn_14x_5m_1h`,
  `qmgr_reachability_99_9_burn_14x_5m_1h`, `queue_headroom_99_9_burn_14x_5m_1h`, plus the
  30m/6h SEV2 windows) about a minute after the symptom alerts and resolved.
  `reports/cert-report.*` holds this run.

**Unified dashboard (later the same evening):** `ibmmq-unified`, "IBM MQ — Unified
Observability", modelled on the KrystalineX unified board: 9 collapsible rows (SLOs &
error budget, queue manager availability, queues, channels, canary & orders flow, queue
manager resources, alerts, logs & traces, telemetry pipeline), 79 panels, all 8 SLIs and
8 SLOs bound, `queue` and `service` variables, Loki logs and a Tempo traces table. Every
one of its 102 panel queries was executed against the live stack (101 return data; the
forecast-alert state series is empty while none is pending). Generated by
`tools/gen-dashboards.mjs` with a flow layout; pack `dashboards[]` entry with 16 bindings.
`certify:quick` at 20:05Z with everything merged into develop: PASS 16/16, S6 clean (all burn
alerts from the 17:44Z chaos run resolved; no alert firing).

**Not equivalent on purpose:** Kafka's chaos `expected_alerts` are burn-rate alerts;
MQ's stay symptom alerts (faster, more specific) with the burn alerts observed as
"also fired" evidence. Kafka's log backend is Elasticsearch; the lab uses Loki.

## 2026-09-16 (afternoon) — first live run on the Windows 11 / Docker Desktop host, stack fixed until it certifies

**State:** the lab runs end to end against a real MQ 10.0.0.5 queue manager on
Docker Desktop for Windows and **certifies PASS**: full run 16:13-16:24Z (11 min),
10/10 conformance, 5/5 synthetic, 5/5 chaos experiments, 8/8 expected alerts fired
within budget and resolved after recovery, MTTD p50 59.6 s / p95 118.7 s.
`reports/cert-report.*` holds that run (git-ignored, regenerate with `npm run certify`).

**Branch/PR:** PR #1 (`develop` → `main`, up to 74ab732) merged 2026-09-16 16:49Z. The policy layer and the unified dashboard are PR #2 (https://github.com/MoebiusX/mq-observability-pack/pull/2), open.
Commits are single-concern; read them in order, each message says what broke live.

### What the first `docker compose up` actually hit (in order)
1. Compose v5 delegates builds to buildx bake; bake on Windows cannot use a git-URL
   build context → exporter now built by `stack/mq-exporter/Dockerfile` (clones the
   pinned tag in-build). producer/consumer got `pull_policy: never`.
2. MQSC typo `STRTSTPEV` → `strmqm` exit 71, AMQ5776E, qmgr never started. Fixed
   (`STRSTPEV`), file made ASCII-only, verified with `runmqsc -v`.
3. Loki image is distroless → compose healthcheck could never pass → removed; Loki
   takes ~5 min to report `/ready` on this config, C1 now waits and records it.
4. Canary: every round-trip `payload_mismatch` — trace-context properties came back
   as an MQRFH2 header in the body. GET with `MQGMO_NO_PROPERTIES`.
5. Canary success ratio was *empty* (not 0) during a 100 % failure, so
   `MQCanaryFailing` never fired → `or vector(0)` in pack, rules and alert.
6. Native endpoint counters are `*_total` (`ibmmq_qmgr_commit_total`,
   `ibmmq_qmgr_destructive_get_total`) → C6, dashboards, evidence updated.
7. App log lines reached Loki as `service_name="docker"` → filelog parses the JSON
   and sets service identity per entry; trace_id/span_id become structured metadata.
8. Grafana Alertmanager datasource has no `/health` → C7 falls back to a proxy probe.
9. Jaeger 2.21 removed the v1 HTTP API that Grafana's Jaeger datasource needs →
   trace store is now **Grafana Tempo 2.10.1** (the pack's declared prod backend);
   C9 uses TraceQL + `/api/v2/traces`. 30/30 consumer receive spans carry a link.
10. Exporter publication gauges miss ~1 scrape in 12 (10 s publish vs 10 s scrape)
    → SLIs read them through `last_over_time(...[30s])`.
11. Exporter `$SYS` "count" elements are per-interval deltas, not counters →
    `overrideCType: false`, rates via `sum_over_time(x[2m]) / 120`, never `rate()`.
12. `STOP LISTENER` alone leaves established SVRCONN conversations working → the
    chaos fault also force-stops both `DEV.APP.SVRCONN` and `DEV.ADMIN.SVRCONN`.
13. Pack ratio SLIs used filter comparisons (`== 2`) and evaluated to 2.0 → `== bool`.
14. Native scrape produced `exported_qmgr` next to the static label → `honor_labels`.
15. Startup zeros (`up{ibmmq-native}=0` before MQ was up) fired the burn-rate alert
    on a fresh stack → collector `depends_on: mq: service_healthy`, `chkmqready`.
16. Self-inflicted: a detached `docker compose run` exporter nobody scraped filled
    its temp reply queue to MAXDEPTH and dead-lettered ~40 publications/10 s
    (1157 on the DLQ). Removed; recorded in `runbooks/dlq.md` as a real DLQ cause.

### Certification runs
| run | scope | verdict | notes |
|---|---|---|---|
| 14:59Z run1 | conformance+synthetic | FAIL 6/15 | first ever; canary RFH2, names, C7, C8, C9, S5 burn alert |
| 15:15Z run2 | conformance+synthetic | FAIL 13/15 | after canary/rules/names/Loki/Grafana fixes; C4 gaps, C9 Jaeger |
| 15:26Z run3 | conformance+synthetic | FAIL 13/15 | Tempo in; Loki still warming, stray-exporter DLQ |
| 15:29Z run4 | conformance+synthetic | **PASS 15/15** | first clean pass |
| 15:31-15:49Z | full, 5 chaos | FAIL | qmgr-down WARN (canary 105 s), listener-stopped FAIL (no channel stop); queue-full 44/34 s, consumer-stall 99.6 s, dlq-poison 47.3 s all PASS; MTTD p50 47 s |
| 15:57-~16:08Z | full, 5 chaos | WARN | all 8 alerts fired and resolved; listener-stopped now detected (`Unreachable` 57.5 s); only the canary alert late (109/108 s, old ratio rule) |
| 16:13-16:24Z | full, 5 chaos | **PASS** | flat-counter canary rule: `MQCanaryFailing` 60.1 / 59.6 s; `Down` 40.1 s, `Unreachable` 59.6 s, `DepthHigh` 49.1 s, `Full` 39.1 s, `AgeHigh` 118.7 s, `DLQ` 48.4 s; resolutions 19.5-38.6 s |

### Measured lab timings (full runs 1-3)
`IBMMQQueueManagerDown` 39-45 s, `IBMMQQueueManagerUnreachable` 57-60 s, `IBMMQQueueFull`
34-39 s, `IBMMQQueueDepthHigh` 44-49 s, `IBMMQDeadLetterQueueNotEmpty` 47-58 s,
`IBMMQOldestMessageAgeHigh` 100-119 s (needs 60 s of age first; budget 150 s),
`MQCanaryFailing` 60 s with the flat-counter rule (105-109 s with the earlier ratio rule).
Resolution after recovery: 20-40 s (canary 30 s; 80-88 s with the old rule). Ingest lag of
canary samples 3-5 s. A full `npm run certify` takes ~11 min.

## Next (in order)
1. Review and merge PR #3. Then tag `v0.2.0` on `main` at the merge commit and push the tag:
   pack and package both declare 0.2.0 and no tag or release exists yet.
2. Review and merge the docs PR (`docs/architecture-and-onboarding` into `develop`).
3. File the four Observogram compiler issues (drafted 2026-09-17, see above).
4. Work the guide's gaps table (`docs/INSTRUMENTING-EXISTING-MQ.md` section 10) in this order:
   C6 accepting the exporter's commit count for the native job; a generator option for
   non-container native panels; canary TLS/CCDT; queue names from the pack in S4 and the
   generator; scrape interval as a pack-level parameter for the generator and SLI windows;
   applying the prod `for:`/`group_wait` overrides; an RDQM state SLI and failover experiment.
5. `npm run down` when done looking at Grafana; the lab has been up since 2026-09-16 21:08Z and
   holds nothing that is not in `reports/` (re-publish with `--publish` after the next `up`).
6. Re-run `npm run certify` after every change under `stack/`, `canary/` or `harness/`;
   the report in `reports/` is the artefact. Expect ~25 min.
7. 2-QM uniform cluster variant, Observogram JSON export of the pack, KrystalineX
   integration (orders bridge RabbitMQ ↔ MQ) as a separate repo/phase.

## Decisions taken (and how to revert them)
- MQ 10.0 stays the default (9.4.5.1 LTS one env var away). Both `MQ_*_PASSWORD` env
  vars and secrets are set; 10.0 logs that it ignores the env vars (expected).
- Tempo replaced Jaeger for the lab. Reverting to Jaeger means pinning ≤ 2.20 (last
  release with the v1 API) and accepting that Grafana breaks on the next Jaeger bump.

## 2026-09-16 — v0.1.0 scaffold (Claude, Cowork session)

**State then:** repo scaffolded end-to-end; statically validated; NOT yet run against
a live queue manager (no Docker daemon in the authoring environment). Everything above
is what running it for real took.
