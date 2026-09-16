# mq-observability-pack

Self-contained IBM MQ observability lab. One `docker compose up` gives you a real
queue manager, the full OTel-native telemetry path (collector → Prometheus / Loki /
Tempo / Grafana), a synthetic canary plus an orders producer/consumer pair with W3C
trace context carried *through* MQ, and a certification harness that injects real
faults, measures MTTD from real alert webhooks, and writes the evidence to
`reports/cert-report.{md,html,json}`.

The contract is [`packs/ibmmq.pack.yaml`](packs/ibmmq.pack.yaml) — an
ObservabilityPack v1.2 manifest in the same shape as the Kafka reference pack in
Observogram. Everything under `stack/` is the executable form of that manifest;
`tools/check-rules.mjs` and the harness keep the two from drifting.

```
docker compose up -d --build --wait     # ~3-5 min first time (builds mq_prometheus from IBM source + canary)
npm run certify                         # settle 90s, conformance + synthetic + 5 chaos experiments (~20 min)
open reports/cert-report.html
```

Prerequisites: Docker Desktop (or any Docker with Compose v2) and Node ≥ 20.19 on
the host for the harness. Nothing else — the harness has zero npm dependencies.
Windows hosts are supported: the exporter builds from `stack/mq-exporter/Dockerfile`
(which clones IBM's repo at the pinned tag) because buildx bake cannot use a git-URL
build context on Windows.

## What you get

| Layer (pack) | Implementation | Where |
|---|---|---|
| L1 Contract — 8 SLIs, 8 SLOs | PromQL over `ibmmq_*` (mq_prometheus), `up{job="ibmmq-native"}`, `mq_canary_*` | `packs/ibmmq.pack.yaml` |
| L2 Telemetry | OTel Collector 0.161 (prometheus + filelog + OTLP receivers → remote-write, Loki OTLP, Tempo OTLP) | `stack/otelcol/config.yaml` |
| L3 Insight | 13 recording rules, 2 provisioned Grafana dashboards bound to SLIs | `stack/prometheus/rules/`, `stack/grafana/dashboards/` |
| L4 Action | 13 alert rules (SEV1-3), Alertmanager → webhook ledger, 5 runbooks with guardrails | `stack/prometheus/rules/ibmmq.alerts.yml`, `runbooks/` |
| L5 Validation | canary + orders flow, 5 chaos experiments, MTTD/MTTR measurement, report | `canary/`, `harness/` |

### The differential-diagnosis idea

MQ is scraped from **two** places on purpose:

* `mq:9157` — the queue manager's **native** metrics (`MQ_ENABLE_METRICS=true`). Qmgr-level only, but it answers as long as the process lives.
* `mq-exporter:9157` — IBM's `mq_prometheus` running as an **MQ client** over `DEV.ADMIN.SVRCONN`. Queue/channel level, but it dies with the listener, the channel, CHLAUTH or CONNAUTH — exactly like your applications.

`IBMMQQueueManagerDown` fires when the first goes dark. `IBMMQQueueManagerUnreachable`
fires when the first is fine and the second is not. The chaos suite proves both
(`qmgr-down` vs `listener-stopped`).

### Ports (all loopback)

| | |
|---|---|
| Grafana | http://127.0.0.1:23000 (admin / admin) |
| Prometheus | http://127.0.0.1:29090 |
| Alertmanager | http://127.0.0.1:29093 |
| Tempo | http://127.0.0.1:23200 (API only — explore traces in Grafana) |
| Loki | http://127.0.0.1:23100 |
| MQ console | https://127.0.0.1:29443/ibmmq/console (admin / passw0rd) |
| MQ listener | 127.0.0.1:21414 (`DEV.APP.SVRCONN`, app / passw0rd) |
| alert-sink ledger | http://127.0.0.1:29095/events |

## Harness

```
node harness/run.mjs                              # everything
node harness/run.mjs --skip-chaos                 # conformance + synthetic (~1 min)
node harness/run.mjs --only chaos --scenario queue-full,dlq-poison
```

Exit code 0 PASS · 1 WARN · 2 FAIL. Checks:

* **Conformance C1-C10** — components healthy; both MQ scrape sources up; every SLI
  returns data; every recording rule loaded *and* producing; every alert the pack
  references (chaos `expected_alerts`, remediation triggers) exists and is healthy;
  required metric families present; dashboards + datasources provisioned; MQ JSON
  logs parsed in Loki and app logs carry `trace_id`; Tempo has the three services
  and consumer `receive` spans carry a span link to a producer trace (context
  propagated through MQ message properties); collector export counters.
* **Synthetic S1-S5** — canary volume, success ≥ 99 %, p99 < 500 ms, orders flowing,
  no pack alert firing.
* **Chaos** — for each `validation.chaos_experiments[]` in the pack: wait for steady
  state, inject, wait for each `expected_alerts` entry in the webhook ledger (MTTD =
  webhook receipt − injection), hold for `fault.duration`, recover, wait for the
  resolved webhooks. PASS = all fired within `expected_mttd` and resolved.

| id | fault | expected |
|---|---|---|
| `qmgr-down` | `docker compose stop mq` | `IBMMQQueueManagerDown`, `MQCanaryFailing` |
| `listener-stopped` | `STOP LISTENER('SYSTEM.LISTENER.TCP.1')` + `STOP CHANNEL(DEV.*.SVRCONN) MODE(FORCE)` | `IBMMQQueueManagerUnreachable`, `MQCanaryFailing` |
| `queue-full` | 200 × `amqsput APP.BURST` (MAXDEPTH 200) | `IBMMQQueueDepthHigh`, `IBMMQQueueFull` |
| `consumer-stall` | stop consumer 150 s | `IBMMQOldestMessageAgeHigh` |
| `dlq-poison` | 3 × `amqsput APP.DLQ` | `IBMMQDeadLetterQueueNotEmpty` |

## Static validation (no Docker needed)

```
npm test                       # syntax + pack schema
node tools/check-rules.mjs     # pack ↔ rules ↔ dashboards cross-check
docker compose config --quiet
promtool check rules stack/prometheus/rules/*.yml
otelcol-contrib validate --config stack/otelcol/config.yaml
```

CI (`.github/workflows/ci.yml`) runs all of the above on every push.

## Versions

MQ `icr.io/ibm-messaging/mq:10.0.0.5-r1` (switch to `9.4.5.1-r1` via `MQ_IMAGE_TAG`),
mq_prometheus built from `ibm-messaging/mq-metric-samples@v6.0.0`, `ibmmq` npm 2.1.x
(OTel propagation built in), otelcol-contrib 0.161.0, Prometheus 3.14, Alertmanager
0.34, Loki 3.7.7, Tempo 2.10.1, Grafana 12.4.11. Tempo rather than Jaeger 2.x on
purpose: Jaeger 2.21 removed the v1 HTTP query API and Grafana's Jaeger datasource
speaks only that API, so trace panes and log→trace links would be dead.

## Layout

```
packs/ibmmq.pack.yaml          the contract
stack/                         executable form: mq, mq-exporter, otelcol, prometheus, alertmanager, loki, tempo, grafana
canary/                        Node + ibmmq + OTel: canary | producer | consumer (MODE=)
harness/                       run.mjs, checks/{conformance,synthetic,chaos}.mjs, lib/, alert-sink/
tools/                         validate-pack, check-rules, gen-dashboards
docs/                          ARCHITECTURE, CERTIFICATION, catalogue-evidence/ibmmq.md
runbooks/                      one per remediation trigger
vendor/observogram/            pack schema + validator (lifted from Observogram)
reports/                       generated certification reports (git-ignored)
```

MIT — Carlos Montero.
