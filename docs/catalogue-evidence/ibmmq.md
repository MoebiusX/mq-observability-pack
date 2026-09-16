# Evidence — `messaging/ibmmq` reference pack

Every non-obvious choice in [`packs/ibmmq.pack.yaml`](../../packs/ibmmq.pack.yaml) is grounded in a public, citeable source, and — unlike a catalogue-only pack — in a **runnable check** in this repo. This document is the audit trail.

**Pack target:** IBM MQ 9.4.x LTS and 10.0.x, container-deployed (`icr.io/ibm-messaging/mq`).
**Tier:** tier-1.
**Last reviewed:** 2026-09-16.

---

## 0. Sources used

| Ref | Source |
|---|---|
| S1 | ibm-messaging/mq-container — `docs/usage.md` (image, `MQ_ENABLE_METRICS`, port 9157, `/etc/mqm/*.mqsc`), `CHANGELOG.md` (10.0.0.0 2026-06, 9.4.5.x) — https://github.com/ibm-messaging/mq-container |
| S2 | ibm-messaging/mq-container — `docs/developer-config.md` (dev objects `DEV.*`, `DEV.APP.SVRCONN`/`DEV.ADMIN.SVRCONN`, secrets `mqAdminPassword`/`mqAppPassword`, `MQ_ADMIN_PASSWORD`/`MQ_APP_PASSWORD` deprecated from 9.4.0) |
| S3 | ibm-messaging/mq-container — `cmd/runmqserver/qmgr.go`: queue manager created with `crtmqm … -p 1414` ⇒ listener `SYSTEM.LISTENER.TCP.1` CONTROL(QMGR) |
| S4 | IBM Docs — *Metrics published by the IBM MQ container* (180+ `ibmmq_*` qmgr-level metrics; **no per-queue metrics** on the native endpoint) — https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=operator-metrics-published-by-mq-container |
| S5 | ibm-messaging/mq-metric-samples — `README.md`, `config.common.yaml`, `cmd/mq_prometheus/config.collector.yaml`, `Dockerfile`, `CHANGELOG.md` (v6.0.0 2026-06-16: `overrideCType` default true, metric include/exclude) — https://github.com/ibm-messaging/mq-metric-samples |
| S6 | ibm-messaging/mq-golang `mqmetric` package — attribute → metric-name mapping (`queue.go`: `depth`, `attribute_max_depth`, `oldest_message_age`, `qtime_short/long`, `input_handles`; `channel.go`: `status`, `status_squash` 0/1/2; `qmgr.go`: `status`) |
| S7 | Grafana Cloud IBM MQ integration — canonical `ibmmq_*` names in the wild (`ibmmq_queue_depth`, `ibmmq_queue_oldest_message_age`, `ibmmq_qmgr_log_write_latency_seconds`, `ibmmq_qmgr_queue_manager_file_system_free_space_percentage`, …) — https://grafana.com/docs/grafana-cloud/monitor-infrastructure/integrations/integration-reference/integration-ibm-mq/ |
| S8 | ibm-messaging/mq-mqi-nodejs — `README.md` "Support for OpenTelemetry Tracing", `lib/mqiotel.js` (traceparent/tracestate as message properties; GET adds a span **link** to the active span) — https://github.com/ibm-messaging/mq-mqi-nodejs |
| S9 | Mark Taylor, *OTel Context Propagation for MQ Applications* (MQ 9.4.1; Go `ibmmqotel`, Node `ibmmq` ≥ 2.1.1, JMS) — https://marketaylor.synology.me/?p=1626 |
| S10 | IBM Docs — *OpenTelemetry tracing* (MQ 9.4.x) — https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=network-opentelemetry-tracing |
| S11 | OpenTelemetry Semantic Conventions — Messaging — https://opentelemetry.io/docs/specs/semconv/messaging/ |
| S12 | Google SRE Workbook, *Alerting on SLOs* (multi-window multi-burn-rate) — https://sre.google/workbook/alerting-on-slos/ |
| S13 | IBM Docs — `ALTER QMGR` MONQ/MONCHL/STATQ/STATMQI/PERFMEV; `DISPLAY QSTATUS` (MSGAGE, QTIME) — https://www.ibm.com/docs/en/ibm-mq/10.0.x |

---

## 1. SLI selection — MQ's vital signs

### `qmgr_process_up` (ratio)
Native `/metrics` on 9157 is served by the container's own Go metrics server, independent of listeners and channels (S1, S4). `up{job="ibmmq-native"}` therefore means "the queue manager process is alive". **Check:** C2, chaos `qmgr-down`.

### `qmgr_reachability` (ratio)
`ibmmq_qmgr_status` from mq_prometheus = `DIS QMSTATUS` STATUS (MQQMSTA_RUNNING = 2). With `keepRunning: true` the exporter keeps serving `0` when it cannot connect (S5: "There's no MQQMSTA_STOPPED … we use 0 to indicate qmgr not available"). Because the exporter is a *client* over `DEV.ADMIN.SVRCONN`, this SLI measures what applications experience. **Check:** C2, chaos `listener-stopped`. Combining the two SLIs gives the differential diagnosis `IBMMQQueueManagerDown` vs `IBMMQQueueManagerUnreachable`.

### `queue_depth_headroom` (threshold 0.8)
`ibmmq_queue_depth` (DIS QSTATUS CURDEPTH) / `ibmmq_queue_attribute_max_depth` (queue attribute, emitted with `useObjectStatus: true`; S6 `ATTR_Q_MAX_DEPTH`). At 1.0 producers receive MQRC_Q_FULL (2053). 80 % mirrors the QDEPTHHI(80) performance event convention (S13). **Check:** chaos `queue-full`.

### `oldest_message_age` (threshold 60 s)
`ibmmq_queue_oldest_message_age` = DIS QSTATUS MSGAGE, requires MONQ (S6, S13; set in `stack/mq/20-observability.mqsc`). Age-in-seconds is the MQ analogue of Kafka consumer lag converted to time: comparable across queues and directly tied to downstream SLOs ("orders processed within 60 s"). **Check:** chaos `consumer-stall`.

### `dlq_depth` (threshold 0)
Depth of the queue named in `ALTER QMGR DEADQ`. Any message there is a delivery failure that a human must dispose of; MQ's own guidance is to monitor the DLQ and run the DLQ handler (`runmqdlq`). **Check:** chaos `dlq-poison`.

### `canary_success` (ratio) and `canary_roundtrip_p99` (threshold 0.5 s)
Client-side truth: a put followed by a get-by-MsgId with a 5 s wait. Emitted by the canary as OTel instruments `mq.canary.attempts{result}` and `mq.canary.roundtrip.duration` (histogram, seconds) → collector → Prometheus remote-write (`mq_canary_attempts_total`, `mq_canary_roundtrip_duration_seconds_bucket`). **Check:** S1-S3, every chaos experiment observes `MQCanaryFailing` where applicable.

### `log_write_latency` (threshold 20 ms)
`ibmmq_qmgr_log_write_latency_seconds` from the `$SYS/MQ/INFO/QMGR/…/Monitor/LOG` publications (S4, S7). Persistent-message throughput is bounded by recovery-log write latency; a jump here precedes queue growth. Not chaos-tested in v0.1 (needs disk-IO fault injection).

---

## 2. Thresholds and SLO objectives
Tier-1 objectives (99.9 % availability/reachability/headroom/canary, 99 % on latency/age) are taken from the Kafka reference pack's tier-2 values tightened one notch, on the basis that MQ carries settlement traffic in the target deployment. They are declared, not derived from history; the pack's `forecasts` and `baselines.review_cadence: monthly` exist to correct them.

## 3. Telemetry pipeline
* Two Prometheus scrape jobs (`ibmmq-native`, `ibmmq-exporter`) in the collector's `prometheus` receiver; remote-write to Prometheus (`--web.enable-remote-write-receiver`).
* Logs: `MQ_LOGGING_CONSOLE_FORMAT=json`, `MQ_LOGGING_CONSOLE_SOURCE=qmgr,web` (S1) put the queue manager error log on stdout as JSON with `ibm_messageId`, `ibm_serverName`, `loglevel`, `message`. The collector's `filelog` receiver tails the docker json-file logs, parses the envelope, then the MQ record, and promotes `service.name=ibmmq` and `mq.qmgr.name`; Loki ingests via OTLP with those as index labels.
* Traces: OTLP from the Node apps → Grafana Tempo. Context crosses MQ as the `traceparent`/`tracestate` message properties (S8, S9); the consumer's `receive` span gets an OTLP span link to the producer's context — that link is what conformance check C9 looks for in Tempo (verified live 2026-09-16: 5/5 consumer receive spans linked). Getters must use `MQGMO_NO_PROPERTIES` (or a message handle); otherwise, with the queue default `PROPCTL(COMPAT)`, the properties arrive as an `MQRFH2` header in the body (S8 `lib/mqiotel.js` getTraceBefore). Jaeger 2.21 was replaced because it removed the v1 HTTP query API that Grafana's Jaeger datasource requires (jaeger#9260).

## 4. Metric-name catalogue used by the pack

**Live-verified 2026-09-16** against `icr.io/ibm-messaging/mq:10.0.0.5-r1` + mq_prometheus v6.0.0 through the OTel Collector 0.161 pipeline. Full inventories (88 native names as scraped, 175 exporter names as stored in Prometheus) are in [`ibmmq-live-metrics-2026-09-16.md`](ibmmq-live-metrics-2026-09-16.md). Names below are **as they exist in Prometheus**, which is what every PromQL in this repo must target.

Exporter job (`job="ibmmq-exporter"`), gauges, names identical to S5/S6/S7 source:
`ibmmq_qmgr_status`, `ibmmq_qmgr_connection_count`, `ibmmq_qmgr_log_write_latency_seconds`, `ibmmq_qmgr_queue_manager_file_system_free_space_percentage`, `ibmmq_qmgr_user_cpu_time_percentage`, `ibmmq_qmgr_system_cpu_time_percentage`, `ibmmq_queue_depth`, `ibmmq_queue_attribute_max_depth`, `ibmmq_queue_oldest_message_age`, `ibmmq_queue_qtime_short`, `ibmmq_queue_qtime_long`, `ibmmq_queue_input_handles`, `ibmmq_queue_output_handles`, `ibmmq_channel_status`, `ibmmq_channel_status_squash`.

Exporter job, MQI counts: `ibmmq_queue_mqput_mqput1_count`, `ibmmq_queue_mqget_count`, `ibmmq_qmgr_commit_count` and the other `$SYS` "count" elements are **per-interval deltas** — one value per 10 s publication, not an accumulating total (measured live: a steady 5 msg/s producer shows a flat ~50). mq_prometheus v6 defaults `overrideCType: true`, which stamps them TYPE counter; the collector's `prometheusremotewrite` (`add_metric_suffixes: true`) then appends `_total`, and `rate()`/`increase()` on them is meaningless. This lab sets `overrideCType: false`, keeps IBM's names verbatim as gauges, and derives per-second rates with `sum_over_time(x[2m]) / 120`. `ibmmq_channel_messages` (DIS CHSTATUS MSGS) is cumulative per channel instance, so `rate()` is correct for it. (`add_metric_suffixes` stays on: it is what turns the canary's OTLP `mq.canary.attempts` into `mq_canary_attempts_total`.)

Native job (`job="ibmmq-native"`, S4), qmgr-level only; counters already carry `_total` at the source and gets are reported as *destructive gets*: `ibmmq_qmgr_commit_total`, `ibmmq_qmgr_mqput_mqput1_total`, `ibmmq_qmgr_destructive_get_total`. The native endpoint also serves `ibmmq_qmgr_log_write_latency_seconds`, `ibmmq_qmgr_queue_manager_file_system_free_space_percentage` and the CPU percentages, so those SLIs have a second source if the client exporter is down.

Labels observed: exporter `qmgr`, `queue`, `channel`, `type`, `platform`, `description`, `usage`, `cluster`, `hostname`, plus `ENV` from `connection.metadataMap`; SVRCONN channel series additionally split by `connname` (one series per connecting client even with `hideSvrConnJobname: true`), so channel panels aggregate `by (channel)`. Native series carry their own `qmgr` label; the collector job scrapes with `honor_labels: true` so it is kept as `qmgr` (without it the static target label wins and the endpoint's becomes `exported_qmgr`), and `up{job="ibmmq-native"}` gets the static `qmgr`.

Known caveat: mq_prometheus v6 `overrideCType: true` reports publication counters as Prometheus counters; if a deployment runs with it off, the `rate()` panels on put/get counts must become plain gauges. Conformance C6 lists every `ibmmq_*` name actually present so the report shows the truth for the image/exporter versions under test.

Operational note: mq_prometheus processes `$SYS` publications on each `Collect`, so a manual `curl` of its `/metrics` between Prometheus scrapes consumes the publications and the next scrape sees no publication-derived series. Judge the exporter from Prometheus (`count_over_time(ibmmq_queue_depth[3m])` = one sample per scrape), not from ad-hoc curls. Even without curls, a 10 s publish interval against a 10 s scrape leaves roughly one scrape in twelve with no publication (measured 55/60 over 10 min), each writing a staleness marker; the SLIs and recording rules therefore read exporter gauges through `last_over_time(...[30s])`.

## 5. Chaos experiments
Faults are docker-level (`engine: litmus` is nominal — the pack schema has no `docker` engine). Each experiment maps to one SLO and to alert names that exist as Prometheus rules (enforced by `tools/check-rules.mjs`). Expected MTTD values assume 10 s scrape, 10 s exporter poll, 10 s rule evaluation, 10-20 s `for`, ≤ 5 s Alertmanager group wait: worst case ≈ 55 s, target 60 s (150 s for message age, which needs 60 s of age to accrue before the threshold is reachable; measured 99.6 s and 117.9 s). Experiments that also expect `MQCanaryFailing` budget 90 s: that alert fires when the canary's ok counter has not moved for 40 s (4 consecutive failed 10 s probes) while probes continue, plus 10 s `for` and evaluation, ≈ 60-70 s. It was first written as a success ratio (`rate(ok)/rate(total) < 0.5` over 2 m then 1 m); measured live that form only became active 69 s after the fault (`ALERTS_FOR_STATE`) and fired at 105-109 s, so it was replaced by the flat-counter form. `IBMMQQueueManagerDown` itself fires in 40-45 s. `listener-stopped` force-stops both SVRCONN channels as well as the listener: stopping the listener alone leaves established client conversations working and nothing is detected (measured live).

## 6. Remediation guardrails
Same envelope as the Kafka reference (max invocations, human-above-severity, cooldown, circuit breaker). DLQ handling is explicitly `manual-only`: a message on the DLQ of a payments queue manager may represent money and is never auto-purged.

## 7. Semconv note
`messaging.system = "ibmmq"` is not in the semconv 1.27 well-known list (S11 lists activemq, jms, kafka, rabbitmq, …); it is used as an open-enum value, consistent with how IBM's own instrumentation names the system.

## 8. Burn-rate policy → Prometheus rules
The spec maps `spec.policy.burn_rate_alerts` to Prometheus alerting rules (spec v1.2 §"targets") and the maturity model requires an alert rule per SLO. `tools/gen-burn-rules.mjs` generates `stack/prometheus/rules/ibmmq.burn.yml` from the pack — 14 multi-window burn-rate alerts (one per declared window, S12), 3 forecast alerts and the error-budget recording rules — using the names, labels and grouping of Observogram's compiler (`tools/lib/compile.mjs`: `<slo>_burn_<factor>x_<short>_<long>`, labels `slo/sli/service/burn_rate/window_short/window_long`, `<slo>_forecast_breach`), so the lab's rule file is what the platform compiler would emit. Two deliberate extensions, because that compiler only handles rate-style ratio SLIs:

* **Error ratio = bad samples / expected samples.** For every SLI the ratio over window *w* is the number of bad 10 s samples (or failed probes) divided by the number the window should contain (*w* / 10 s), not by the samples that happen to exist. State-style ratio SLIs (`good: sum(up == bool 1)`, `sum(ibmmq_qmgr_status == bool 2)`) count `sum_over_time((1 - <state>)[w:10s])`; the canary counts `increase(total) − increase(ok)`; threshold SLIs count samples of the recorded SLI above the threshold (`sum_over_time((max(<recorded>) > bool <threshold>)[w:10s])`, the "time-based SLO" reading of "99 % of the time, message age < 60 s"). Measured reason: `avg_over_time` / `rate` over a partly-filled window is a since-start average on a fresh TSDB, so every 6 h window fired after the first 90 s fault of a session (the 6 h leg of `qmgr_process_up` was 0.51 at 15:00 with 35 of 2 160 expected samples). Consequence, stated plainly: time with no samples counts as good; the symptom alerts `IBMMQQueueManagerDown` / `IBMMQExporterDown` and the canary's `absent()` own the "no data" failure mode.
* **Short-window floor.** The short leg also needs ≥ 2 bad samples. With the long leg loaded by an incident, one bad 10 s sample in 5 m is a 3.3 % error ratio, above the 14 × 0.1 % = 1.4 % threshold, and re-fired SEV1 for the rest of the hour on a single failed probe.
* **Forecasts** regress the recorded 1 h burn rate over 1 d and require it to have exceeded 1× for the last 2 h (`predict_linear(burn_1h[1d], horizon) > 1 and min_over_time(burn_1h[2h]) > 1`). The compiler's `predict_linear` of the 5 m error ratio was measured to fire for 28 min after a 2 min outage ("breach within 7 d", predicted ratio 29.9): a post-incident echo, not a forecast. The pack's `holt-winters` / `percentile-of-history` methods are implemented as this linear rule in the lab and say so in the annotation.
* Every threshold SLI here is an upper bound; the spec has no direction field, the generator rejects a negative threshold and states the assumption.
* **Forecast horizon and severity.** The projection horizon is capped at the 1 d regression window: `predict_linear(burn_1h[1d], 7d)` multiplies a 1 d slope by 7 (measured on the same series at the same instant: −87 for 1 d vs −4 049 for 7 d), so a declining post-incident tail projected 7 d out is noise, not a forecast. The alert annotation states the horizon actually evaluated next to the one the pack declares. The forecast alert's severity follows the pack's `on_projected_breach` (`page_oncall` → SEV1, `open_ticket` → SEV2, `post_warning` → SEV3): routing is by severity only, and a `page_oncall` forecast emitted as SEV3 would have landed in the team channel.

Burn threshold = `factor × (1 − objective)`; both windows must exceed it (S12). Lab `for:` is 30 s / 2 m / 5 m by short window (the compiler's production defaults are 2 m / 5 m / 10 m). Slow windows (1 h / 6 h) keep firing for hours after any incident by design; the harness therefore grades symptom alerts (S5) and burn-rate alerts (S6, fast windows FAIL, slow windows WARN) separately. `tools/check-rules.mjs` fails when a policy window or forecast has no matching alert rule, compares the generated per-SLO recording rules symmetrically between pack and stack (name, `slo`/`sli`/`service` labels and expression) and resolves every `ref:slis.<id>` recording rule to the SLI it names (threshold SLIs: the query verbatim; ratio SLIs: the same selectors, since the stack records a 5 m smoothing of the pack's instantaneous fraction), so a stale or drifted copy on either side fails.
