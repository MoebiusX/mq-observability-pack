# STATUS

## 2026-09-16 (afternoon) — first live run on Nitro5, stack fixed until it certifies

**State:** the lab runs end to end against a real MQ 10.0.0.5 queue manager on
Docker Desktop for Windows. Conformance C1-C10 and synthetic S1-S5 pass (15/15,
run 4 at 15:29Z). Chaos: see "Certification runs" below. `reports/cert-report.*`
holds the latest full run (git-ignored, regenerate with `npm run certify`).

**Branch/PR:** `develop` → PR #1 to `main` (https://github.com/MoebiusX/mq-observability-pack/pull/1).
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
    chaos fault also force-stops both `DEV.*.SVRCONN` channels.
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
| 15:57-16:20Z | full, 5 chaos | WARN | all 8 alerts fired and resolved; listener-stopped now detected (`Unreachable` 57.5 s); only the canary alert late (109/108 s, old ratio rule) |

### Measured lab timings (full runs 1-2)
`IBMMQQueueManagerDown` 39-45 s, `IBMMQQueueManagerUnreachable` 57.5 s, `IBMMQQueueFull`
34-38 s, `IBMMQQueueDepthHigh` 44-48 s, `IBMMQDeadLetterQueueNotEmpty` 47-58 s,
`IBMMQOldestMessageAgeHigh` 100-118 s (needs 60 s of age first; budget raised to 150 s),
`MQCanaryFailing` 105-109 s with the ratio rule (replaced by the flat-counter rule,
budget 90 s). Resolution after recovery: 20-88 s. Ingest lag of canary samples 3-5 s.

## Next (in order)
1. Re-run `npm run certify` after every change under `stack/`, `canary/` or `harness/`;
   the report in `reports/` is the artefact. Expect ~25 min.
2. 2-QM uniform cluster variant, Observogram JSON export of the pack, KrystalineX
   integration (orders bridge RabbitMQ ↔ MQ) as a separate repo/phase.

## Open decisions
- MQ 10.0 stays the default (9.4.5.1 LTS one env var away). Both `MQ_*_PASSWORD` env
  vars and secrets are set; 10.0 logs that it ignores the env vars (expected).
- Tempo replaced Jaeger for the lab. Reverting to Jaeger means pinning ≤ 2.20 (last
  release with the v1 API) and accepting that Grafana breaks on the next Jaeger bump.

## 2026-09-16 — v0.1.0 scaffold (Claude, Cowork session)

**State then:** repo scaffolded end-to-end; statically validated; NOT yet run against
a live queue manager (no Docker daemon in the authoring environment). Everything above
is what running it for real took.
