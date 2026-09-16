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
* Traces: OTLP from the Node apps → Jaeger v2 (OTLP native). Context crosses MQ as the `traceparent`/`tracestate` message properties (S8, S9); the consumer's `receive` span gets a `FOLLOWS_FROM` link to the producer's context — that link is what conformance check C9 looks for in Jaeger.

## 4. Metric-name catalogue used by the pack (all verified in S5/S6/S7 source)
`ibmmq_qmgr_status`, `ibmmq_qmgr_connection_count`, `ibmmq_qmgr_log_write_latency_seconds`, `ibmmq_qmgr_queue_manager_file_system_free_space_percentage`, `ibmmq_qmgr_user_cpu_time_percentage`, `ibmmq_qmgr_system_cpu_time_percentage`, `ibmmq_qmgr_commit_count`, `ibmmq_queue_depth`, `ibmmq_queue_attribute_max_depth`, `ibmmq_queue_oldest_message_age`, `ibmmq_queue_qtime_short`, `ibmmq_queue_qtime_long`, `ibmmq_queue_input_handles`, `ibmmq_queue_output_handles`, `ibmmq_queue_mqput_mqput1_count`, `ibmmq_queue_mqget_count`, `ibmmq_channel_status`, `ibmmq_channel_status_squash`, `ibmmq_channel_messages`.
Labels: `qmgr`, `queue`, `channel`, `type`, `platform`, `description`, `usage`, `cluster` (S5 `exporter.go`).

Known caveat: mq_prometheus v6 `overrideCType: true` reports publication counters as Prometheus counters; if a deployment runs with it off, the `rate()` panels on put/get counts must become plain gauges. Conformance C6 lists every `ibmmq_*` name actually present so the report shows the truth for the image/exporter versions under test.

## 5. Chaos experiments
Faults are docker-level (`engine: litmus` is nominal — the pack schema has no `docker` engine). Each experiment maps to one SLO and to alert names that exist as Prometheus rules (enforced by `tools/check-rules.mjs`). Expected MTTD values assume 10 s scrape, 10 s exporter poll, 10 s rule evaluation, 10-20 s `for`, ≤ 5 s Alertmanager group wait: worst case ≈ 55 s, target 60 s (120 s for message age, which needs 60 s of age to accrue first).

## 6. Remediation guardrails
Same envelope as the Kafka reference (max invocations, human-above-severity, cooldown, circuit breaker). DLQ handling is explicitly `manual-only`: a message on the DLQ of a payments queue manager may represent money and is never auto-purged.

## 7. Semconv note
`messaging.system = "ibmmq"` is not in the semconv 1.27 well-known list (S11 lists activemq, jms, kafka, rabbitmq, …); it is used as an open-enum value, consistent with how IBM's own instrumentation names the system.
