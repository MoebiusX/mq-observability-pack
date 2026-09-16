# Adversarial review — 2026-09-16 (everything on `develop` since the scaffold)

Eight independent read-only reviewers, one lens each (rules/PromQL, burn-rate generator,
harness integrity, dashboards, telemetry pipeline, canary apps, documentation claims,
security/supply chain), each required to back every finding with something observed on the
live stack or in the code. Findings were then re-verified here before being accepted; the
ones below are the accepted HIGH and MEDIUM ones, with the remediation plan and its status.
LOW findings that were fixed because the same file was open are listed at the end.

Side effect worth recording: one reviewer ran the chaos suite despite instructions and its
process was killed mid-hold at 20:15Z, which left the listener and both SVRCONN channels
stopped for 2.5 minutes until repaired by hand. That incident is H2's live evidence.

Severity: HIGH = wrong result, false PASS, lab left broken, build broken; MEDIUM = misleading,
fragile, fails under realistic conditions, weakens supply-chain integrity.

## HIGH

| id | finding | where | fix | status |
|---|---|---|---|---|
| H1 | A fresh Windows clone (core.autocrlf=true, the Git for Windows default) checks out every file as CRLF; a CRLF Dockerfile fails to parse at its first backslash continuation, so `npm run up` cannot build the exporter. Verified with a clone and a CRLF build (`unknown instruction: &&`). | repo | `.gitattributes` with `* text=auto eol=lf` | done |
| H2 | An interrupted chaos run (Ctrl-C, tool timeout, crash) leaves the fault injected: no try/finally, no signal handler, no repair command, no pre-flight. Observed live at 20:15Z. | `harness/checks/chaos.mjs`, `harness/run.mjs` | try/finally around inject→recover; SIGINT/SIGTERM run the in-flight recover; `--recover` runs every fault's recover; pre-flight refuses to inject on a dirty lab | done |
| H3 | Unknown `--only`/`--scenario` values, or an experiment with no fault implementation, produce verdict PASS with zero checks (SKIP is ignored by `verdictOf`). `--out --skip-chaos` writes to a directory named `--skip-chaos`. | `harness/run.mjs`, `harness/lib/report.mjs` | validate suite and scenario names (exit 2), SKIP counts as WARN, a requested suite with zero checks is FAIL, option values may not start with `--` | done |
| H4 | Any exception exits 1, the documented WARN code, and writes no report. | `harness/run.mjs` | catch-all: log, write a report with verdict ERROR when possible, exit 3; `unhandledRejection` likewise | done |
| H5 | "SLI before/during/after" samples `result[0]` of a multi-series vector (queue-full reported 0/0/0 while APP.BURST was full) and never enters the verdict; the pack's `steady_state_hypothesis` is decorative. | `harness/checks/chaos.mjs` | sample the SLO's worst series (max for `<=`/`<` SLOs, min for `>=`/`>`), store every series, grade: hypothesis holds before and after, violated during, else WARN with a note | done |
| H6 | "Channel messages / s" and "bytes / s" panels use `rate()` on per-interval deltas (raw samples 99/50/99/50…) and show about half the real throughput; CLAUDE.md and evidence §4 claimed `ibmmq_channel_messages` is cumulative. | `tools/gen-dashboards.mjs`, docs | `sum_over_time(x[2m]) / 120` like the queue panels; correct both documents | done |
| H7 | Overview "Queue manager log" panel pipes the plain-text MQ message through `\| json`; 895 of 927 lines error (`JSONParserErr`) and render as a bare message id. verify-dashboards graded it healthy. | `tools/gen-dashboards.mjs` | drop `\| json`; the message id is already structured metadata | done |
| H8 | The orders consumer grows its native heap by about 1 KB per consumed message (heap +1000 kB per 1075 GETs, V8 flat; producer and canary do not grow). No memory limit on the app services. | `canary/src/index.mjs`, `docker-compose.yaml` | measured: ~1.1 KB/GET with the ibmmq OTel hook, ~0.4 KB/GET without (`MQIJS_NOOTEL=1`), reconnecting every 1000 messages releases nothing, so the leak is in the client library and goes upstream; bounded by `mem_limit: 512m` + restart policy (the container recycles itself about daily at 5 msg/s); an optional `CONSUMER_RECYCLE_EVERY` knob exists but is off | bounded, not fixed |
| H9 | The consumer busy-loops with no delay on any GET error that is not a reconnect (GET(DISABLED), truncation, …): one warn line and one span per millisecond into an unrotated json-file log. | `canary/src/index.mjs`, `docker-compose.yaml` | `else sleep(1000)`, accept and dead-letter truncated messages, json-file rotation on every service | done |

## MEDIUM

| id | finding | where | fix | status |
|---|---|---|---|---|
| M1 | `runmqsc()` swallows every MQSC error (the `AMQ8` heuristic matches success and error codes alike), so a failed inject or recover is silent. | `harness/lib/docker.mjs` | parse the `N valid MQSC commands could not be processed` trailer; throw unless every error is allow-listed (AMQ8420 only); record output in notes | done |
| M2 | CERTIFICATION.md says the JSON holds every webhook event and timestamp; chaos rows store only derived durations. | `harness/checks/chaos.mjs`, `docs/CERTIFICATION.md` | store `firedAt`, `resolvedAt`, `fingerprint`, `startsAt` and a per-experiment snapshot of the ledger | done |
| M3 | Gates are advisory: pre-injection steady-state timeout only adds a note; post-recovery timeout is dropped; "resolved" is matched by alertname not fingerprint; `/healthy/i` matches `unhealthy`; hold is measured from injection so a slow detection extends the fault. | `harness/checks/chaos.mjs` | steady-state timeout → FAIL and skip; post-recovery timeout → WARN; resolved must match the firing fingerprint; `/^healthy$/`; check `waitHealthy`/drain results | done |
| M4 | S4 passes on 2-minute rates alone while printing put errors, depth and age it never judges (seen PASS with 43 put errors). | `harness/checks/synthetic.mjs` | grade put errors = 0, depth below the headroom SLO, age ≤ 60 s | done |
| M5 | Hold timer mixes the sink clock with the host clock; `sinkNow()` silently falls back to the host clock. | `harness/checks/chaos.mjs` | host-clock deadline for the hold; `sinkNow()` retries then throws | done |
| M6 | Forecast alerts clamp the horizon to 1 d but annotate the pack's 7 d / 3 d and §8 documents the pack horizon; not one of the four documented deviations. | `tools/gen-burn-rules.mjs`, evidence §8, CLAUDE.md | annotate the horizon actually used; document as deviation 5 | done |
| M7 | check-rules skips every `ref:slis.<id>` recording rule, so the stack expression behind the five threshold SLIs is never compared with the pack's SLI query; `sli`/`service` labels are not part of the comparison key. | `tools/check-rules.mjs` | resolve `ref:` to the SLI: threshold SLIs must match the query verbatim (whitespace-free), ratio SLIs must use exactly the pack's selectors (the stack records a 5 m smoothing of the instantaneous fraction); `sli`/`service` in the key; every alert must carry the three labels and an existing runbook | done |
| M8 | `IBMMQExporterDown` flaps fire→resolve every ~50 s during a queue-manager outage (the exporter answers one scrape in five while retrying). 6 fire/resolve pairs for 3 qmgr-down runs. | `stack/prometheus/rules/ibmmq.alerts.yml` | `keep_firing_for: 1m`; promtool unit test | done |
| M9 | If the collector dies, every `up{}`-based alert goes silent (selectors are empty, not zero); the only alert is `MQCanaryFailing` five minutes later, blaming the canary. | `stack/prometheus/rules/ibmmq.alerts.yml`, runbooks | `IBMMQTelemetryPipelineDown` on `absent_over_time(up{job="ibmmq-native"}[1m])`, SEV1, runbook, unit test | done |
| M10 | `IBMMQQueueManagerUnreachable` joins with `and on ()`, so with two queue managers a dead QM2 also raises "unreachable" for QM2 while QM1 is up; it also pends for 10-20 s after every restart. | `stack/prometheus/rules/ibmmq.alerts.yml` | `and on (qmgr) (min_over_time(up{job="ibmmq-native"}[1m]) == 1)`; unit test; chaos budget re-measured | done |
| M11 | `ibmmq:queue_depth_headroom:ratio` wraps only the numerator in `last_over_time`, so a publication gap empties the ratio and IBMMQQueueFull / DepthHigh resolve and re-fire. | pack + `stack/prometheus/rules/ibmmq.recording.yml` | wrap `ibmmq_queue_attribute_max_depth` too (pack and stack identically) | done |
| M12 | verify-dashboards grades "some rows came back": Loki `__error__` streams count as data, `or vector(0)` masks a wrong metric name, instant-only, ignores `row.panels`. | `tools/verify-dashboards.mjs` | error streams are errors; evaluate `or vector(0)` targets with the fallback stripped and report masked empties; walk nested row panels; warn when symptom alerts are firing | done |
| M13 | Burn-rate stat colours use 6×/14× for every SLO although message_age and dlq_empty page at 4×/10× and log_latency at 3×/8×. | `tools/gen-dashboards.mjs` | thresholds from each SLO's `spec.policy` factors | done |
| M14 | The unified logs panel's "All" (`.+`) includes the `docker` fallback service (28 % of lines are Grafana/Loki/Prometheus noise) that is not offered as a choice. | `tools/gen-dashboards.mjs` | `allValue` = the four MQ services | done |
| M15 | `$SYS` monitoring publications inherit `USEDLQ(YES)` from SYSTEM.ADMIN.TOPIC (verified via TPSTATUS), so an unscraped exporter fills its reply queue and dead-letters ~4 publications/s into APP.DLQ, firing the DLQ alert on a healthy queue manager (happened once today). | `stack/mq/20-observability.mqsc` | `ALTER TOPIC('SYSTEM.ADMIN.TOPIC') USEDLQ(NO)`; verified inherited status after apply | done |
| M16 | Only the four app services have a restart policy; MQ, the collector and every backend stay down after a Docker restart or crash. | `docker-compose.yaml` | `restart: unless-stopped` everywhere (chaos uses explicit stop/start, which the policy honours) | done |
| M17 | `start_at: end` plus "collector starts after MQ is healthy" drops every container's startup lines on a fresh stack, including the MQSC verdict. | `stack/otelcol/config.yaml` | `start_at: beginning` (file_storage keeps offsets across restarts) together with M18's project filter | done |
| M18 | The filelog include glob is host-wide and service identity is inferred from line shape: other compose projects on the host would be ingested, and the apps' own MQI error lines land under `service_name="docker"`. | `docker-compose.yaml`, `stack/otelcol/config.yaml` | json-file `labels` (compose project and service) on every service; filelog drops other projects and takes the default service name from the compose service label | done |
| M19 | Build inputs float: `ubi8-minimal:latest`, `go-toolset:1.21`, a git tag with no commit check, an IBM tarball with no checksum, `node:22-*` tags, and a Dockerfile comment claiming `MQIJS_VRM` pins the MQ client when nothing sets it. | `stack/mq-exporter/Dockerfile`, `canary/Dockerfile`, `harness/alert-sink/Dockerfile` | digests for every base image, tag→commit SHA check, tarball sha256, `MQIJS_VRM`/`MQIJS_FIXPACK`, non-root exporter | done |
| M20 | CI has no `permissions:`, actions pinned to `v4` tags, and three binaries downloaded with no integrity check. | `.github/workflows/ci.yml` | `permissions: contents: read`, actions pinned to commit SHAs, `sha256sum -c` against each project's published checksum file, `promtool test rules` step | done |
| M21 | `Session.ensure()` overwrites a live `hConn` when OPEN fails, leaking one conversation per retry (2 s) until the channel's instance limit is hit. | `canary/src/index.mjs` | disconnect on OPEN failure before rethrowing | done |
| M22 | `MQCanaryFailing` needs `increase(attempts[40s]) > 0` or `absent()`; a canary blocked inside MQCONN/MQPUT keeps exporting a flat counter and neither branch is true. | `stack/prometheus/rules/ibmmq.alerts.yml`, pack | third branch: no attempt at all in 2 minutes; unit test | done |
| M23 | Canary messages carry no expiry; every probe whose GET does not consume its message leaves it on APP.CANARY forever, until the queue is full and every probe fails. | `canary/src/mq.mjs`, `canary/src/index.mjs` | `MQMD.Expiry` = 30 s on canary puts | done |
| M24 | Documentation claims that did not survive checking (see the documentation section below). | docs | corrected | done |

## LOW findings fixed in passing

- Canary p99 SLI/recording rule included failed probes (`{result="ok"}` filter; timer starts after connect).
- Forecast alert severity now follows `on_projected_breach` (page_oncall→SEV1, open_ticket→SEV2, post_warning→SEV3).
- Markdown report escapes `|` and `<` in cells; `certify:quick`/`--only` runs default to `reports/quick/` so a full run's report is not overwritten.
- `harness/lib/docker.mjs` validates queue and queue-manager names before interpolating them into a shell command.
- alert-sink: 1 MiB body cap, 20 000-event ring buffer.
- Consumer disconnects cleanly on SIGTERM; `MQRC_NOT_AUTHORIZED` classified as `auth_failed`, not `connect_failed`.
- SLO-burn dashboard shows all 8 SLOs (the generator now fails if the list and the pack disagree); queues "Channel status" aggregates instances.
- Machine hostname removed from the committed docs.
- verify-dashboards also evaluates the template variables' queries.

Reported LOW and left as is: the C6 metric-family list is still hand-maintained (documented in
CLAUDE.md); `otel_scope_*` labels on remote-written series; deprecated collector component
aliases; `mq.qmgr.name` record attribute shadowing the index label; APP.DLQ inside the `app`
principal's profile; the canary "expected samples" leg under-counting by one probe at the
first appearance of a result class. The burn reviewer read the evidence file's "S12" as an
Observogram section; it is the evidence file's own source id (Google SRE Workbook), not a
defect.

## Documentation findings (M24)

The documentation reviewer reported an hour after the others, and disclosed that it was the
one who ran the chaos suite: on the committed harness `--help` was an unknown flag, unknown
flags were ignored, and a full run started; its `| head` closed the pipe and the process died
mid-fault (H2/H3 in one incident). Its findings, and what was done:

| # | finding | done |
|---|---|---|
| D1 (HIGH) | any unrecognised flag ran the full chaos suite; an interrupted run could not recover | H2/H3: unknown flags exit 3, `--recover`, pre-flight, `finally` |
| D2 (HIGH) | CERTIFICATION.md claimed every webhook event and timestamp is in the JSON; none were | M2: stored; document rewritten to say exactly what is kept |
| D3 (MED) | SKIP certified PASS | H3: SKIP is WARN |
| D4 (MED) | three different `certify` durations, none measured | ~15 min in README/CLAUDE.md (11.7 min measured + settle) |
| D5 (MED) | STATUS run table had two full runs overlapping in time | second row corrected to 15:57-~16:08Z |
| D6 (MED) | the documented local promtool exec command skipped the generated burn file | all three files listed |
| D7 (MED) | rule 7 points at prod overrides that did not exist | pack `environments.prod.overrides` now declares scrape/poll intervals, symptom and burn `for:`, Alertmanager group_wait |
| D8 (MED) | canary runbook described the retired ratio rule | rewritten for the flat-counter rule and the hung-canary branch |
| D9 (MED) | "runbooks with guardrails" / named automations read as implemented | README and four runbooks say they are declared in the pack for the platform, done by hand here |
| D10 (MED) | evidence §4 "Known caveat" described the inverse configuration | rewritten |
| D11 (MED) | ARCHITECTURE said the harness refuses to inject while alerts fire; it injected after 4 min | harness now refuses (pre-flight, steady-state skip); text rewritten to the real loop |
| D12 (LOW) | deviation count 2/3/4/5 across files | five, numbered identically in the generator header, evidence §8 and CLAUDE.md |
| D13 (LOW) | compose said Loki is ready in 15-30 s | ~5 min (measured) |
| D14 (LOW) | pack promised `external_labels: {service: ibmmq}` the stack never applied; `kind: k6` unexplained | collector remote-write now sets it (verified on `up{}`); k6 noted as nominal in evidence §5 |
| D15 (LOW) | "Open decisions" were closed | renamed "Decisions taken (and how to revert them)" |
| D16 (LOW) | `STOP CHANNEL(DEV.*.SVRCONN)` is not valid MQSC | README, STATUS and the MQSC comment name both channels |
| D17 (LOW) | grouped: "3 entrypoints", "(v0.1)", DLQ "resolves after 20 s", OTel vs Prometheus metric name in a runbook, "5/5" spans, `npm run burn-rules --pack-snippet` drops the flag, README static block missing the env vars, layout missing the live inventory, CI drift step blind to untracked files | all corrected |

Also checked by the reviewer and found consistent: every metric name in docs/pack/rules/
dashboards/runbooks exists in the live TSDB, ports and versions match compose, every
documented env override is read by the code, all runbook links resolve, STATUS numbers match
the report.

## Accepted as designed / not changed

- Dev credentials committed for the loopback-only lab (documented).
- `APP.DLQ` inside the `app` principal's `APP.**` profile: acceptable for the lab, noted for prod.
- Slow-window burn alerts firing for hours after an incident (S6 grades them WARN on purpose).
- OTel collector scope labels on every remote-written series, deprecated component aliases: tracked, not changed in this pass.
