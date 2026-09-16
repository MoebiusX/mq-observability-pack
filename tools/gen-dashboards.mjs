#!/usr/bin/env node
// Generates stack/grafana/dashboards/*.json from a compact panel spec so the
// dashboards stay reviewable in a diff. Panel ids match packs/ibmmq.pack.yaml
// panel_bindings (stored in the panel description as "binds_to: ...").
import { writeFileSync } from 'node:fs';
const DS = { type: 'prometheus', uid: 'prom' };
let nextId = 1;
const base = (p, extra) => ({ id: nextId++, datasource: DS, ...extra, ...p });

function stat(title, expr, { binds, unit = 'none', thresholds, x, y, w = 4, h = 4, decimals } = {}) {
  return base({}, {
    type: 'stat', title, description: binds ? `binds_to: ${binds}` : undefined,
    gridPos: { x, y, w, h },
    targets: [{ refId: 'A', expr, instant: true }],
    fieldConfig: { defaults: { unit, decimals, thresholds: { mode: 'absolute', steps: thresholds || [{ color: 'green', value: null }] } }, overrides: [] },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'background', graphMode: 'none', textMode: 'value' },
  });
}
function ts(title, targets, { binds, unit = 'none', x, y, w = 12, h = 8, min, max, legend = 'list' } = {}) {
  return base({}, {
    type: 'timeseries', title, description: binds ? `binds_to: ${binds}` : undefined,
    gridPos: { x, y, w, h },
    targets: targets.map((t, i) => ({ refId: String.fromCharCode(65 + i), expr: t.expr, legendFormat: t.legend || '__auto' })),
    fieldConfig: { defaults: { unit, min, max, custom: { lineWidth: 2, fillOpacity: 8, showPoints: 'never' } }, overrides: [] },
    options: { legend: { displayMode: legend, placement: 'bottom' }, tooltip: { mode: 'multi', sort: 'desc' } },
  });
}
function logs(title, expr, { x, y, w = 24, h = 8 } = {}) {
  return base({}, { type: 'logs', title, datasource: { type: 'loki', uid: 'loki' }, gridPos: { x, y, w, h },
    targets: [{ refId: 'A', expr }], options: { showTime: true, wrapLogMessage: true, dedupStrategy: 'none', sortOrder: 'Descending' } });
}
function dashboard(uid, title, panels, tags) {
  return { uid, title, tags, timezone: 'browser', schemaVersion: 41, version: 1, editable: true, graphTooltip: 1, refresh: '10s',
    time: { from: 'now-30m', to: 'now' }, templating: { list: [] }, annotations: { list: [
      { name: 'Pack alerts', datasource: DS, enable: true, iconColor: '#d03b3b', expr: 'ALERTS{alertstate="firing", pack="ibmmq"}', step: '10s', titleFormat: '{{alertname}}', textFormat: '{{severity}} {{queue}}' } ] },
    links: [{ title: 'IBM MQ folder', type: 'dashboards', tags: ['ibmmq'], asDropdown: true }], panels };
}

const green = (bad, warn) => [{ color: 'green', value: null }, { color: 'orange', value: warn }, { color: 'red', value: bad }];
const redBelow = (warn, bad) => [{ color: 'red', value: null }, { color: 'orange', value: bad }, { color: 'green', value: warn }];

// ---------------------------------------------------------------- overview
nextId = 1;
const overview = dashboard('ibmmq-overview', 'IBM MQ — Overview (pack SLIs)', [
  stat('QMgr process up', 'ibmmq:qmgr_process_up:ratio_5m', { binds: 'slis.qmgr_process_up', unit: 'percentunit', thresholds: redBelow(0.999, 0.99), x: 0, y: 0, decimals: 2 }),
  stat('QMgr reachable', 'ibmmq:qmgr_reachability:ratio_5m', { binds: 'slis.qmgr_reachability', unit: 'percentunit', thresholds: redBelow(0.999, 0.99), x: 4, y: 0, decimals: 2 }),
  stat('Queue headroom (max)', 'max(ibmmq:queue_depth_headroom:ratio)', { binds: 'slis.queue_depth_headroom', unit: 'percentunit', thresholds: green(1, 0.8), x: 8, y: 0 }),
  stat('Oldest message age', 'max(ibmmq:oldest_message_age:seconds_max)', { binds: 'slis.oldest_message_age', unit: 's', thresholds: green(120, 60), x: 12, y: 0 }),
  stat('DLQ depth', 'ibmmq:dlq_depth:max', { binds: 'slis.dlq_depth', unit: 'none', thresholds: green(10, 1), x: 16, y: 0 }),
  stat('Canary success (5m)', 'ibmmq:canary_success:ratio_5m', { binds: 'slis.canary_success', unit: 'percentunit', thresholds: redBelow(0.999, 0.99), x: 20, y: 0, decimals: 2 }),
  stat('Canary p99 RTT', 'ibmmq:canary_roundtrip:p99_5m', { binds: 'slis.canary_roundtrip_p99', unit: 's', thresholds: green(1, 0.5), x: 0, y: 4, decimals: 3 }),
  stat('Log write latency', 'ibmmq:log_write_latency:seconds', { binds: 'slis.log_write_latency', unit: 's', thresholds: green(0.05, 0.02), x: 4, y: 4, decimals: 4 }),
  stat('SLO burn 1h · process up', 'ibmmq:errorbudget:burn_1h{slo="qmgr_process_up_99_9"}', { binds: 'slos.qmgr_process_up_99_9', thresholds: green(14, 6), x: 8, y: 4, decimals: 1 }),
  stat('SLO burn 1h · canary', 'ibmmq:errorbudget:burn_1h{slo="canary_success_99_9"}', { binds: 'slos.canary_success_99_9', thresholds: green(14, 6), x: 12, y: 4, decimals: 1 }),
  stat('Connections', 'max(ibmmq_qmgr_connection_count{job="ibmmq-exporter"})', { x: 16, y: 4 }),
  stat('Firing pack alerts', 'count(ALERTS{alertstate="firing", pack="ibmmq"}) or vector(0)', { thresholds: green(1, 1), x: 20, y: 4 }),

  ts('Availability: process vs reachability', [
    { expr: 'ibmmq:qmgr_process_up:ratio_5m', legend: 'process up (native :9157)' },
    { expr: 'ibmmq:qmgr_reachability:ratio_5m', legend: 'reachable (client exporter)' },
  ], { binds: 'slis.qmgr_process_up', unit: 'percentunit', min: 0, max: 1, x: 0, y: 8 }),
  ts('Canary round-trip (p50 / p99)', [
    { expr: 'histogram_quantile(0.5, sum by (le)(rate(mq_canary_roundtrip_duration_seconds_bucket[5m])))', legend: 'p50' },
    { expr: 'ibmmq:canary_roundtrip:p99_5m', legend: 'p99' },
  ], { binds: 'slis.canary_roundtrip_p99', unit: 's', x: 12, y: 8 }),
  ts('Queue depth headroom by queue', [{ expr: 'ibmmq:queue_depth_headroom:ratio', legend: '{{queue}}' }], { binds: 'slis.queue_depth_headroom', unit: 'percentunit', min: 0, max: 1, x: 0, y: 16 }),
  ts('Oldest message age by queue', [{ expr: 'ibmmq:oldest_message_age:seconds_max', legend: '{{queue}}' }], { binds: 'slis.oldest_message_age', unit: 's', x: 12, y: 16 }),
  ts('Canary attempts by result', [{ expr: 'sum by (result)(rate(mq_canary_attempts_total[2m]))', legend: '{{result}}' }], { binds: 'slis.canary_success', unit: 'ops', x: 0, y: 24 }),
  ts('Orders flow: produced vs consumed', [
    { expr: 'sum(rate(mq_orders_produced_total[2m]))', legend: 'produced/s' },
    { expr: 'sum(rate(mq_orders_consumed_total[2m]))', legend: 'consumed/s' },
    { expr: 'sum(rate(mq_orders_put_errors_total[2m]))', legend: 'put errors/s' },
  ], { unit: 'ops', x: 12, y: 24 }),
  ts('Recovery log write latency', [{ expr: 'ibmmq:log_write_latency:seconds', legend: '{{qmgr}}' }], { binds: 'slis.log_write_latency', unit: 's', x: 0, y: 32 }),
  ts('QMgr CPU / filesystem', [
    { expr: 'max by (qmgr)(ibmmq_qmgr_user_cpu_time_percentage{job="ibmmq-exporter"})', legend: 'user cpu %' },
    { expr: 'max by (qmgr)(ibmmq_qmgr_system_cpu_time_percentage{job="ibmmq-exporter"})', legend: 'system cpu %' },
    { expr: 'min by (qmgr)(ibmmq_qmgr_queue_manager_file_system_free_space_percentage{job="ibmmq-exporter"})', legend: 'fs free %' },
  ], { unit: 'percent', x: 12, y: 32 }),
  logs('Queue manager log (Loki, parsed MQ JSON)', '{service_name="ibmmq"} | json | line_format "{{.mq_message_id}} {{.body}}"', { x: 0, y: 40 }),
], ['ibmmq', 'pack', 'slo']);

// ------------------------------------------------------------------ queues
nextId = 1;
const queues = dashboard('ibmmq-queues', 'IBM MQ — Queues & Channels', [
  ts('Depth by queue', [{ expr: 'ibmmq_queue_depth{job="ibmmq-exporter"}', legend: '{{queue}}' }], { binds: 'ref:queries.per_queue_depth', x: 0, y: 0 }),
  ts('MAXDEPTH by queue', [{ expr: 'ibmmq_queue_attribute_max_depth{job="ibmmq-exporter"}', legend: '{{queue}}' }], { x: 12, y: 0 }),
  // mq_prometheus publishes MQI counts as PER-INTERVAL DELTAS (one value per 10 s $SYS
  // publication), scraped as gauges (overrideCType: false). Per-second rate =
  // sum_over_time(...[2m]) / 120 — never rate() (docs/catalogue-evidence/ibmmq.md §4).
  ts('Put rate by queue', [{ expr: 'sum by (queue)(sum_over_time(ibmmq_queue_mqput_mqput1_count{job="ibmmq-exporter"}[2m])) / 120', legend: '{{queue}}' }], { binds: 'ref:queries.per_queue_throughput', unit: 'ops', x: 0, y: 8 }),
  ts('Get rate by queue', [{ expr: 'sum by (queue)(sum_over_time(ibmmq_queue_mqget_count{job="ibmmq-exporter"}[2m])) / 120', legend: '{{queue}}' }], { unit: 'ops', x: 12, y: 8 }),
  ts('Oldest message age by queue', [{ expr: 'ibmmq_queue_oldest_message_age{job="ibmmq-exporter"}', legend: '{{queue}}' }], { unit: 's', x: 0, y: 16 }),
  ts('Queue time (short / long sample)', [
    { expr: 'ibmmq_queue_qtime_short{job="ibmmq-exporter"}', legend: '{{queue}} short' },
    { expr: 'ibmmq_queue_qtime_long{job="ibmmq-exporter"}', legend: '{{queue}} long' },
  ], { unit: 'µs', x: 12, y: 16 }),
  ts('Open handles (input / output)', [
    { expr: 'ibmmq_queue_input_handles{job="ibmmq-exporter"}', legend: '{{queue}} in' },
    { expr: 'ibmmq_queue_output_handles{job="ibmmq-exporter"}', legend: '{{queue}} out' },
  ], { x: 0, y: 24 }),
  ts('Channel status (0 stopped · 1 transition · 2 running)', [{ expr: 'ibmmq_channel_status_squash{job="ibmmq-exporter"}', legend: '{{channel}} ({{type}})' }], { binds: 'ref:queries.per_channel_status', min: 0, max: 2, x: 12, y: 24 }),
  ts('Channel messages / bytes', [
    // DIS CHSTATUS MSGS is cumulative per channel instance, so rate() is right here.
    { expr: 'sum by (channel)(rate(ibmmq_channel_messages{job="ibmmq-exporter"}[2m]))', legend: '{{channel}} msgs/s' },
  ], { unit: 'ops', x: 0, y: 32 }),
  // Native endpoint names verified live against MQ 10.0.0.5: counters carry a _total suffix
  // and gets are reported as destructive_get (docs/catalogue-evidence/ibmmq.md §4b).
  ts('Native endpoint: commits / MQI calls (qmgr-level)', [
    { expr: 'rate(ibmmq_qmgr_commit_total{job="ibmmq-native"}[2m])', legend: 'commits/s' },
    { expr: 'rate(ibmmq_qmgr_mqput_mqput1_total{job="ibmmq-native"}[2m])', legend: 'mqput/s' },
    { expr: 'rate(ibmmq_qmgr_destructive_get_total{job="ibmmq-native"}[2m])', legend: 'destructive get/s' },
  ], { unit: 'ops', x: 12, y: 32 }),
], ['ibmmq', 'pack']);

writeFileSync('stack/grafana/dashboards/ibmmq-overview.json', JSON.stringify(overview, null, 2) + '\n');
writeFileSync('stack/grafana/dashboards/ibmmq-queues.json', JSON.stringify(queues, null, 2) + '\n');
console.log('dashboards written');
