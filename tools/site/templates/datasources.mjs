// tools/site/templates/datasources.mjs — grafana/provisioning/datasources/datasources.yaml
//
// The lab file (stack/grafana/provisioning/datasources/datasources.yaml) with the datasource URLs
// from the environment's endpoints and timeInterval at the step. The uids (prom, loki, tempo,
// alertmanager) are fixed: the boards and conformance C7 reference them. URL derivation: the
// Prometheus query API is the origin of the remote-write endpoint (a Mimir tenant serves it under
// /prometheus: set `grafana_prometheus` in the inventory's endpoints when that differs), Loki's is
// the origin of its OTLP endpoint, Tempo's HTTP API is port 3200 of the OTLP host.

import { origin, hostOnly } from './lib.mjs';

export function render(ctx) {
  const t = ctx.timing, e = ctx.endpoints;
  const prom = e.grafana_prometheus || origin(e.remote_write);
  const loki = origin(e.loki);
  const tempo = `http://${hostOnly(e.tempo)}:3200`;
  return `apiVersion: 1
# Remove the datasource the lab shipped before switching traces to Tempo (see below);
# provisioning never deletes datasources on its own.
deleteDatasources:
  - name: Jaeger
    orgId: 1
datasources:
  - name: Prometheus
    uid: prom
    type: prometheus
    access: proxy
    url: ${prom}
    isDefault: true
    jsonData:
      timeInterval: ${t.dur(t.timeInterval)}
      exemplarTraceIdDestinations:
        - name: trace_id
          datasourceUid: tempo
  - name: Loki
    uid: loki
    type: loki
    access: proxy
    url: ${loki}
    jsonData:
      derivedFields:
        - name: TraceID
          matcherRegex: '(?:trace_id|traceparent)[=:"\\s]+(?:00-)?([0-9a-f]{32})'
          url: '$\${__value.raw}'
          datasourceUid: tempo
  # Tempo, not Jaeger: Jaeger 2.21 dropped the v1 HTTP API that Grafana's Jaeger datasource
  # requires (verified live: health check and search both fail against 2.21.0).
  - name: Tempo
    uid: tempo
    type: tempo
    access: proxy
    url: ${tempo}
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        spanStartTimeShift: '-5m'
        spanEndTimeShift: '5m'
        filterByTraceID: true
        filterBySpanID: false
        tags: [ { key: 'service.name', value: 'service_name' } ]
      tracesToMetrics:
        datasourceUid: prom
        queries:
          - name: canary p99
            query: 'ibmmq:canary_roundtrip:p99_5m'
      nodeGraph:
        enabled: true
  - name: Alertmanager
    uid: alertmanager
    type: alertmanager
    access: proxy
    url: ${e.alertmanager}
    jsonData:
      implementation: prometheus
      handleGrafanaManagedAlerts: false
`;
}
