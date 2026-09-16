# Architecture

```
                 ┌────────────────────────────────────────────────────────────────┐
                 │ docker compose (name: mq-obs, all ports on 127.0.0.1:2xxxx)    │
                 │                                                                │
  canary ──MQI──▶│  mq (QM1)  icr.io/ibm-messaging/mq:10.0.0.5-r1                │
  producer ─────▶│   ├─ :1414 listener  DEV.APP.SVRCONN (app) / DEV.ADMIN.SVRCONN │
  consumer ◀─────│   ├─ :9157 native /metrics  ─────────────┐                     │
                 │   └─ stdout JSON error log ──────────┐   │                     │
                 │                                      │   │                     │
                 │  mq-exporter (mq_prometheus v6.0.0)  │   │                     │
                 │   client over DEV.ADMIN.SVRCONN      │   │                     │
                 │   :9157 ibmmq_queue_* ibmmq_channel_*│   │                     │
                 │        │                             │   │                     │
                 │        ▼ prometheus receiver         ▼   ▼                     │
                 │  otel-collector 0.161 ◀── OTLP (spans + canary metrics) ───────┤
                 │   ├─ prometheusremotewrite ─▶ prometheus 3.14 ─▶ alertmanager ─▶ alert-sink (webhook ledger)
                 │   ├─ otlphttp ──────────────▶ loki 3.7                          │
                 │   └─ otlp ──────────────────▶ tempo 2.10                        │
                 │                                                                │
                 │  grafana 12.4 (provisioned: datasources + IBM MQ folder)       │
                 └────────────────────────────────────────────────────────────────┘
                                   ▲ HTTP APIs
                 harness/run.mjs ──┘  (host, Node ≥ 20, no deps)  ─▶ reports/cert-report.{json,md,html}
                    └─ docker compose stop/start/exec runmqsc|amqsput   (chaos faults)
```

## Why two metric sources
Native endpoint = process liveness (qmgr-level only, S4 in the evidence doc). Client exporter = application-visible reachability + queue/channel detail. Their disagreement is a diagnosis, not noise.

## Why the collector scrapes and Prometheus only receives
One telemetry path for all three signals, identical to the production shape (collector → Mimir/Tempo/Loki), so the lab certifies the same pipeline configuration that ships.

## Why the alert ledger
Alertmanager's `startsAt` is the evaluation time, not the delivery time. MTTD in the report is measured at the point a human/automation would first hear about it: the webhook receipt. The sink stores the raw payloads; the harness never trusts its own clock alone.

## Trace propagation through MQ
The Node `ibmmq` module, when `@opentelemetry/api` is loaded, sets `traceparent`/`tracestate` message properties on MQPUT and, on MQGET, adds a span link from the active consumer span to the producer context. The consumer keeps a CONSUMER span active around the GET precisely so that link lands. Tempo stores it as an OTLP span link (Grafana renders it under "Links"); conformance C9 counts consumer `receive` spans whose link points at another trace.

Getter-side detail learned live: with the queue default `PROPCTL(COMPAT)` and no message handle on the MQGET, those properties come back as an `MQRFH2` header prepended to the body (Format `MQHRF2`), which broke the canary's payload comparison and would corrupt the orders JSON. The apps therefore GET with `MQGMO_NO_PROPERTIES`; the module then swaps in its own handle, reads the context for the link, and hands the application the clean body.

## Why Tempo and not Jaeger
Jaeger 2.21 removed the v1 HTTP query API ("remove v1 http endpoints the ui no longer calls", jaeger#9260) and Grafana 12.4's Jaeger datasource speaks only that API, so Explore and the Loki → trace derived field had nothing to talk to. Tempo is Grafana-native and is the pack's declared production trace backend, so the lab now certifies the same trace path that ships.

## Chaos loop
pre-flight (every fault's `clean()` must be null, otherwise nothing is injected and the suite FAILs with a pointer to `--recover`) → steady-state (the expected alerts must clear within 4 min, otherwise the experiment is skipped with a note) → sample the hypothesis SLI (worst series) → inject → wait for expected alert webhooks (MTTD) → hold `fault.duration` from injection → sample the SLI again → recover (always: `finally`, and on SIGINT/SIGTERM) → wait for the same alert instances (fingerprint) to resolve → wait for steady state (a timeout grades the row WARN) → sample the SLI a third time → next. One experiment at a time. PASS needs every alert fired within budget and resolved, and the hypothesis holding / violated / holding.
