# STATUS

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
1. Re-run `npm run certify` after every change under `stack/`, `canary/` or `harness/`;
   the report in `reports/` is the artefact. Expect ~25 min.
2. 2-QM uniform cluster variant, Observogram JSON export of the pack, KrystalineX
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
