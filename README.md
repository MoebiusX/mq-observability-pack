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
npm run certify                         # settle 90s, conformance + synthetic + 5 chaos experiments (~15 min)
open reports/cert-report.html
```

How it all fits together, at four levels of detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
To make a queue manager you already run (installed on Linux, multi-instance, an RDQM group,
a uniform cluster) produce the same telemetry so this pack applies to it:
[`docs/INSTRUMENTING-EXISTING-MQ.md`](docs/INSTRUMENTING-EXISTING-MQ.md).

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
| L3 Insight | 11 SLI recording rules + 21 error-budget rules generated from the policy, 4 provisioned Grafana dashboards bound to SLIs/SLOs (overview, queues & channels, SLO burn, and **IBM MQ — Unified Observability**: one board in the pack's own order — SLIs and SLOs, then the validation that proves them with the last certification's verdict, MTTD and MTTR per alert against budget, then policy and alerting, remediation from the pack, the signals underneath, the pipeline, logs and traces) | `stack/prometheus/rules/`, `stack/grafana/dashboards/` |
| L4 Action | 12 symptom alerts (incl. a telemetry-pipeline-down alert, because an absent series fires nothing) + 14 multi-window burn-rate alerts + 3 forecast alerts (the latter two generated from `spec.policy`), promtool unit tests for the alerts that once misbehaved live, Alertmanager → webhook ledger, 7 runbooks (the automations and rate guardrails they mention are declared in the pack's `remediation` for the platform; this lab does not enforce them) | `stack/prometheus/rules/ibmmq.alerts.yml`, `ibmmq.burn.yml`, `stack/prometheus/tests/`, `runbooks/` |
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
| Grafana | http://127.0.0.1:23000 (admin / admin) — start at `/d/ibmmq-unified` |
| Prometheus | http://127.0.0.1:29090 |
| Alertmanager | http://127.0.0.1:29093 |
| Tempo | http://127.0.0.1:23200 (API only — explore traces in Grafana) |
| Loki | http://127.0.0.1:23100 |
| MQ console | https://127.0.0.1:29443/ibmmq/console (admin / passw0rd) |
| MQ listener | 127.0.0.1:21414 (`DEV.APP.SVRCONN`, app / passw0rd) |
| alert-sink ledger | http://127.0.0.1:29095/events · `/metrics` exposes the last certification run (verdict, MTTD/MTTR per alert) for the boards |

## Harness

```
node harness/run.mjs                              # everything → reports/
node harness/run.mjs --skip-chaos                 # conformance + synthetic (~1 min) → reports/quick/
node harness/run.mjs --only chaos --scenario queue-full,dlq-poison
node harness/run.mjs --recover                    # repair a lab an interrupted run left in a fault state
node harness/run.mjs --publish reports/cert-report.json   # re-publish a report's MTTD/MTTR to the alert-sink → dashboards
```

Every run publishes its summary to the alert-sink, whose `/metrics` the collector scrapes:
the dashboards' validation row shows the last verdict, when it ran, MTTD p50/p95 and MTTR
p50/p95 against the pack baselines, and every expected alert's detection time against its
`expected_mttd`.

Exit code 0 PASS · 1 WARN · 2 FAIL · 3 harness error (no verdict). A mistyped suite or
scenario name is an error, never a PASS; an experiment without a fault implementation is a
WARN. Chaos recovery runs in a `finally` and on Ctrl-C; the suite refuses to inject on a lab
that still carries a previous fault. Checks:

* **Conformance C1-C10** — components healthy; both MQ scrape sources up; every SLI
  returns data; every recording rule loaded *and* producing; every alert the pack
  references (chaos `expected_alerts`, remediation triggers) exists and is healthy;
  required metric families present; dashboards + datasources provisioned; MQ JSON
  logs parsed in Loki and app logs carry `trace_id`; Tempo has the three services
  and consumer `receive` spans carry a span link to a producer trace (context
  propagated through MQ message properties); collector export counters.
* **Synthetic S1-S6** — canary volume, success ≥ 99 %, p99 < 500 ms, orders flowing,
  no symptom alert firing, no fast-window burn-rate alert firing (slow 6 h windows may
  still be paying for earlier incidents and only WARN).
* **Chaos** — for each `validation.chaos_experiments[]` in the pack: wait for steady
  state, inject, wait for each `expected_alerts` entry in the webhook ledger (MTTD =
  webhook receipt − injection), hold for `fault.duration`, recover, wait for the same
  alert instance (fingerprint) to resolve. The `steady_state_hypothesis` SLO's worst series
  is sampled before, during and after: PASS needs it holding / violated / holding again,
  every alert fired within `expected_mttd` and resolved; the report keeps the alert-sink
  events each experiment was judged from.

| id | fault | expected |
|---|---|---|
| `qmgr-down` | `docker compose stop mq` | `IBMMQQueueManagerDown`, `MQCanaryFailing` |
| `listener-stopped` | `STOP LISTENER('SYSTEM.LISTENER.TCP.1')` + `STOP CHANNEL('DEV.APP.SVRCONN') MODE(FORCE) + the same for DEV.ADMIN.SVRCONN` | `IBMMQQueueManagerUnreachable`, `MQCanaryFailing` |
| `queue-full` | 200 × `amqsput APP.BURST` (MAXDEPTH 200) | `IBMMQQueueDepthHigh`, `IBMMQQueueFull` |
| `consumer-stall` | stop consumer 150 s | `IBMMQOldestMessageAgeHigh` |
| `dlq-poison` | 3 × `amqsput APP.DLQ` | `IBMMQDeadLetterQueueNotEmpty` |

## Static validation (no Docker needed)

```
npm test                       # syntax + pack schema
node tools/check-rules.mjs     # pack ↔ rules ↔ dashboards ↔ policy cross-check
npm run generate               # regenerate dashboards and the burn-rate rules from the pack (CI diffs them)
docker compose config --quiet
promtool check rules stack/prometheus/rules/*.yml
promtool test rules stack/prometheus/tests/*.yml     # unit tests for the alerts
ENV=lab MQ_QMGR_NAME=QM1 otelcol-contrib validate --config stack/otelcol/config.yaml
```

CI (`.github/workflows/ci.yml`) runs all of the above on every push, with a read-only token,
actions pinned to commit SHAs and every downloaded binary verified against its project's
published checksum. Build inputs are pinned to content as well: base images by digest, the
exporter's source tag by commit, the IBM client tarball by SHA-256 (`stack/mq-exporter/Dockerfile`,
`canary/Dockerfile`).

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
tools/                         validate-pack, check-rules, gen-dashboards + dashboards/ibmmq.mjs (the MQ boards), gen-burn-rules (spec.policy → Prometheus alerts); the generators are thin wrappers over Observogram's library in vendor/
docs/                          ARCHITECTURE (four levels), INSTRUMENTING-EXISTING-MQ (existing queue managers, RDQM), CERTIFICATION, catalogue-evidence/ (evidence trail + the live metric inventory), reviews/
runbooks/                      one per remediation trigger
vendor/observogram/            pack schema + validator (lifted from Observogram)
reports/                       generated certification reports (git-ignored)
```

MIT — Carlos Montero.
