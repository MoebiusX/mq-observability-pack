# IBMMQTelemetryPipelineDown — no MQ telemetry is reaching Prometheus

**Severity:** SEV1 · **SLI:** `qmgr_process_up` (the one that has gone blind) · **Fires when:**
`up{job="ibmmq-native"}` has had no sample for over a minute.

## Why this alert exists

Every MQ alert in this pack is evaluated over series that only exist while the OTel
Collector scrapes the queue manager and remote-writes into Prometheus. When the collector
dies, `up{job="ibmmq-native"}` does not become 0 — it disappears — and every `== 0`
selector is empty. Without this alert the first symptom would be `MQCanaryFailing` five
minutes later (its `absent()` branch), which names the wrong component.

## Triage (in order)

1. Is the collector alive?
   ```
   docker compose ps otel-collector
   docker compose logs --tail=100 otel-collector
   curl -s http://127.0.0.1:23133/          # health_check extension
   ```
   Exit code 137 or a `memory_limiter` message means it was OOM-killed or is refusing data.
2. Is the collector scraping the queue manager?
   ```
   curl -s http://127.0.0.1:28888/metrics | grep -E 'otelcol_scraper_(scraped|errored)_metric_points'
   ```
   Errored points with a healthy collector point at `mq:9157` (queue manager container down or
   `MQ_ENABLE_METRICS` off). If `IBMMQQueueManagerDown` is *also* silent, this is the case.
3. Is Prometheus accepting remote-write?
   ```
   curl -s http://127.0.0.1:29090/-/ready
   curl -s http://127.0.0.1:28888/metrics | grep otelcol_exporter_send_failed_metric_points
   ```

## Remediation

- Collector down or wedged: `docker compose restart otel-collector`. It keeps file offsets
  in the `otelcol-state` volume, so logs are not re-ingested.
- Prometheus refusing writes: check disk (`--storage.tsdb.retention.time=2d`), then restart.
- After recovery, expect the burn-rate alerts to stay quiet: time with no samples counts as
  good in the generated rules on purpose; this alert is the accounting for that gap.

## Guardrails

Do not "fix" this by lowering `for:` on the other alerts — they cannot fire on absent data
regardless of `for:`. Do not delete the `otelcol-state` volume unless you want every
container log re-ingested from its beginning.
