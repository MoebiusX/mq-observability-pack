#!/usr/bin/env node
// Generates stack/grafana/dashboards/*.json from a compact panel spec so the
// dashboards stay reviewable in a diff. Panel ids match packs/ibmmq.pack.yaml
// panel_bindings (stored in the panel description as "binds_to: ...").
import { writeFileSync } from 'node:fs';
const DS = { type: 'prometheus', uid: 'prom' };
let nextId = 1;
const base = (p, extra) => ({ id: nextId++, datasource: DS, ...extra, ...p });

function stat(title, expr, { binds, unit = 'none', thresholds, x, y, w = 4, h = 4, decimals, mappings } = {}) {
  return base({}, {
    type: 'stat', title, description: binds ? `binds_to: ${binds}` : undefined,
    gridPos: { x, y, w, h },
    targets: [{ refId: 'A', expr, instant: true }],
    fieldConfig: { defaults: { unit, decimals, mappings: mappings || [], thresholds: { mode: 'absolute', steps: thresholds || [{ color: 'green', value: null }] } }, overrides: [] },
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
// ---- extra building blocks for the unified dashboard ------------------------------------
// A collapsible section header. Panels that follow it belong to the row until the next one.
function row(title) {
  return base({}, { type: 'row', title, collapsed: false, gridPos: { x: 0, y: 0, w: 24, h: 1 }, panels: [] });
}
// Generic table panel (Prometheus instant query → table, or any datasource target list).
function table(title, targets, { binds, x, y, w = 12, h = 8, datasource = DS, transformations = [], overrides = [] } = {}) {
  return base({}, {
    type: 'table', title, description: binds ? `binds_to: ${binds}` : undefined, datasource,
    gridPos: { x, y, w, h },
    targets: targets.map((t, i) => ({ refId: String.fromCharCode(65 + i), datasource, ...t })),
    transformations,
    fieldConfig: { defaults: { custom: { align: 'auto', cellOptions: { type: 'auto' } } }, overrides },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false, reducer: ['sum'], countRows: false, fields: '' } },
  });
}
// Recent traces from Tempo as a table (same result shape Explore shows for a TraceQL search).
function traces(title, traceql, { x, y, w = 24, h = 8, limit = 20 } = {}) {
  const datasource = { type: 'tempo', uid: 'tempo' };
  return base({}, {
    type: 'table', title, datasource, gridPos: { x, y, w, h },
    targets: [{ refId: 'A', datasource, queryType: 'traceql', query: traceql, limit, tableType: 'traces' }],
    options: { showHeader: true, cellHeight: 'sm' },
  });
}
// Flow layout: lays panels out left-to-right in 24-column rows in the order given, starting at
// `startY`; a `row` panel always starts a new line and spans the width. Returns { panels, nextY }.
function flow(items, startY = 0) {
  let x = 0, y = startY, lineH = 0;
  const out = [];
  for (const p of items) {
    const w = p.type === 'row' ? 24 : p.gridPos.w, h = p.type === 'row' ? 1 : p.gridPos.h;
    if (p.type === 'row' || x + w > 24) { x = 0; y += lineH; lineH = 0; }
    p.gridPos = { x, y, w, h };
    x += w; lineH = Math.max(lineH, h);
    if (p.type === 'row') { x = 0; y += 1; lineH = 0; }
    out.push(p);
  }
  return { panels: out, nextY: y + lineH };
}
const pct = (v) => `${(v * 100).toFixed(0)}%`;

function dashboard(uid, title, panels, tags, { templating = { list: [] }, time = { from: 'now-30m', to: 'now' } } = {}) {
  return { uid, title, tags, timezone: 'browser', schemaVersion: 41, version: 1, editable: true, graphTooltip: 1, refresh: '10s',
    time, templating, annotations: { list: [
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

// ---------------------------------------------------------------- slo burn
// One stat per SLO (bound to slos.<id>) reading the generated ibmmq:errorbudget:burn_1h
// series, the fast/slow burn curves for all SLOs, and the burn-rate/forecast alert state.
nextId = 1;
const SLOS = [
  ['qmgr_process_up_99_9', 'QMgr process up 99.9%'], ['qmgr_reachability_99_9', 'QMgr reachable 99.9%'],
  ['queue_headroom_99_9', 'Queue headroom 99.9%'], ['message_age_99_under_60s', 'Message age <60s 99%'],
  ['dlq_empty_99_9', 'DLQ empty 99.9%'], ['canary_success_99_9', 'Canary success 99.9%'],
  ['log_latency_99_under_20ms', 'Log latency <20ms 99%'],
];
const sloBurn = dashboard('ibmmq-slo-burn', 'IBM MQ — SLO burn rates', [
  ...SLOS.map(([id, title], i) => stat(`${title} · burn 1h`, `ibmmq:errorbudget:burn_1h{slo="${id}"}`,
    { binds: `slos.${id}`, thresholds: green(14, 6), x: (i % 6) * 4, y: Math.floor(i / 6) * 4, decimals: 1 })),
  stat('Burn-rate alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", burn_rate!=""}) or vector(0)', { thresholds: green(1, 1), x: 4, y: 4 }),
  ts('Burn rate · fast window (5m)', [{ expr: 'ibmmq:errorbudget:burn_5m', legend: '{{slo}}' }], { x: 0, y: 8 }),
  ts('Burn rate · slow window (1h)', [{ expr: 'ibmmq:errorbudget:burn_1h', legend: '{{slo}}' }], { x: 12, y: 8 }),
  ts('Error ratio · 5m, per SLI', [{ expr: '{__name__=~"ibmmq:.*:error_ratio_5m"}', legend: '{{__name__}}' }], { unit: 'percentunit', x: 0, y: 16 }),
  ts('Burn-rate / forecast alerts (1 = pending, 2 = firing)', [
    { expr: '(2 * max by (alertname) (ALERTS{pack="ibmmq", alertstate="firing", burn_rate!=""})) or max by (alertname) (ALERTS{pack="ibmmq", alertstate="pending", burn_rate!=""})', legend: '{{alertname}}' },
    { expr: '(2 * max by (alertname) (ALERTS{pack="ibmmq", alertstate="firing", kind="forecast"})) or max by (alertname) (ALERTS{pack="ibmmq", alertstate="pending", kind="forecast"})', legend: '{{alertname}}' },
  ], { min: 0, max: 2, x: 12, y: 16, legend: 'table' }),
], ['ibmmq', 'pack', 'slo']);

// ---------------------------------------------------------------- unified
// Everything on one board, in the shape of the KrystalineX "Unified Observability" dashboard:
// collapsible domain rows, stats + time series per row, alerts, then logs and traces. Every
// SLI/SLO panel is pack-bound; every metric name is in docs/catalogue-evidence/ibmmq-live-metrics-2026-09-16.md.
// Layout is computed by flow(), so add panels in reading order and never by coordinates.
nextId = 1;
const EXP = 'job="ibmmq-exporter"', NAT = 'job="ibmmq-native"', Q = 'queue=~"$queue"';
const LOGSVC = 'service_name=~"${service:regex}"';
const RUNNING = [{ type: 'value', options: { '2': { text: 'RUNNING', color: 'green' }, '0': { text: 'UNREACHABLE', color: 'red' }, '1': { text: 'STARTING', color: 'orange' }, '3': { text: 'QUIESCING', color: 'orange' } } }];
const ONOFF = [{ type: 'value', options: { '1': { text: 'up', color: 'green' }, '0': { text: 'down', color: 'red' } } }];
const items = [
  // ---- SLOs & error budget
  row('🎯 SLOs & error budget'),
  stat('QMgr process up', 'ibmmq:qmgr_process_up:ratio_5m', { binds: 'slis.qmgr_process_up', unit: 'percentunit', thresholds: redBelow(0.999, 0.99), decimals: 2, w: 3 }),
  stat('QMgr reachable', 'ibmmq:qmgr_reachability:ratio_5m', { binds: 'slis.qmgr_reachability', unit: 'percentunit', thresholds: redBelow(0.999, 0.99), decimals: 2, w: 3 }),
  stat('Queue headroom (max)', 'max(ibmmq:queue_depth_headroom:ratio)', { binds: 'slis.queue_depth_headroom', unit: 'percentunit', thresholds: green(1, 0.8), w: 3 }),
  stat('Oldest message age', 'max(ibmmq:oldest_message_age:seconds_max)', { binds: 'slis.oldest_message_age', unit: 's', thresholds: green(120, 60), w: 3 }),
  stat('DLQ depth', 'ibmmq:dlq_depth:max', { binds: 'slis.dlq_depth', thresholds: green(10, 1), w: 3 }),
  stat('Canary success (5m)', 'ibmmq:canary_success:ratio_5m', { binds: 'slis.canary_success', unit: 'percentunit', thresholds: redBelow(0.999, 0.99), decimals: 2, w: 3 }),
  stat('Canary p99 RTT', 'ibmmq:canary_roundtrip:p99_5m', { binds: 'slis.canary_roundtrip_p99', unit: 's', thresholds: green(1, 0.5), decimals: 3, w: 3 }),
  stat('Log write latency', 'ibmmq:log_write_latency:seconds', { binds: 'slis.log_write_latency', unit: 's', thresholds: green(0.05, 0.02), decimals: 4, w: 3 }),
  ...[
    ['qmgr_process_up_99_9', 'process up'], ['qmgr_reachability_99_9', 'reachable'], ['queue_headroom_99_9', 'headroom'], ['message_age_99_under_60s', 'message age'],
    ['dlq_empty_99_9', 'DLQ empty'], ['canary_success_99_9', 'canary success'], ['canary_latency_99_p99_500ms', 'canary p99'], ['log_latency_99_under_20ms', 'log latency'],
  ].map(([id, t]) => stat(`Burn 1h · ${t}`, `ibmmq:errorbudget:burn_1h{slo="${id}"}`, { binds: `slos.${id}`, thresholds: green(14, 6), decimals: 1, w: 3, h: 3 })),
  ts('Burn rate · fast window (5m)', [{ expr: 'ibmmq:errorbudget:burn_5m', legend: '{{slo}}' }], { w: 12, h: 6 }),
  ts('Burn rate · slow window (1h)', [{ expr: 'ibmmq:errorbudget:burn_1h', legend: '{{slo}}' }], { w: 12, h: 6 }),

  // ---- Queue manager availability
  row('🟢 Queue manager availability'),
  stat('QMgr status (client view)', `max(ibmmq_qmgr_status{${EXP}})`, { mappings: RUNNING, thresholds: [{ color: 'red', value: null }, { color: 'green', value: 2 }], w: 4 }),
  stat('Native endpoint', `max(up{${NAT}})`, { mappings: ONOFF, thresholds: redBelow(1, 1), w: 4 }),
  stat('Exporter scraped', `max(up{${EXP}})`, { mappings: ONOFF, thresholds: redBelow(1, 1), w: 4 }),
  stat('Connections', `max(ibmmq_qmgr_connection_count{${EXP}})`, { w: 4 }),
  stat('Active listeners', `max(ibmmq_qmgr_active_listeners{${EXP}})`, { thresholds: redBelow(1, 1), w: 4 }),
  stat('QMgr uptime', `max(ibmmq_qmgr_uptime{${EXP}})`, { unit: 's', w: 4 }),
  ts('Availability: process (native) vs reachability (client exporter)', [
    { expr: 'ibmmq:qmgr_process_up:ratio_5m', legend: 'process up' },
    { expr: 'ibmmq:qmgr_reachability:ratio_5m', legend: 'reachable' },
  ], { unit: 'percentunit', min: 0, max: 1, w: 12, h: 6 }),
  ts('Command server / channel initiator status (0 = stopped)', [
    { expr: `max(ibmmq_qmgr_command_server_status{${EXP}})`, legend: 'command server' },
    { expr: `max(ibmmq_qmgr_channel_initiator_status{${EXP}})`, legend: 'channel initiator' },
  ], { w: 12, h: 6 }),

  // ---- Queues
  row('📦 Queues'),
  ts('Depth by queue', [{ expr: `max by (queue)(ibmmq_queue_depth{${EXP}, ${Q}})`, legend: '{{queue}}' }], { w: 12, h: 7 }),
  ts('Headroom (depth / MAXDEPTH) by queue', [{ expr: `ibmmq:queue_depth_headroom:ratio{${Q}}`, legend: '{{queue}}' }], { unit: 'percentunit', min: 0, max: 1, w: 12, h: 7 }),
  ts('Oldest message age by queue', [{ expr: `ibmmq:oldest_message_age:seconds_max{${Q}}`, legend: '{{queue}}' }], { unit: 's', w: 8, h: 6 }),
  ts('Put / get rate by queue (per-interval deltas ÷ 120 s)', [
    { expr: `sum by (queue)(sum_over_time(ibmmq_queue_mqput_mqput1_count{${EXP}, ${Q}}[2m])) / 120`, legend: '{{queue}} put/s' },
    { expr: `sum by (queue)(sum_over_time(ibmmq_queue_mqget_count{${EXP}, ${Q}}[2m])) / 120`, legend: '{{queue}} get/s' },
  ], { unit: 'ops', w: 8, h: 6 }),
  ts('Open handles by queue (in / out)', [
    { expr: `max by (queue)(ibmmq_queue_input_handles{${EXP}, ${Q}})`, legend: '{{queue}} in' },
    { expr: `max by (queue)(ibmmq_queue_output_handles{${EXP}, ${Q}})`, legend: '{{queue}} out' },
  ], { w: 8, h: 6 }),
  ts('Queue time (short / long sample)', [
    { expr: `max by (queue)(ibmmq_queue_qtime_short{${EXP}, ${Q}})`, legend: '{{queue}} short' },
    { expr: `max by (queue)(ibmmq_queue_qtime_long{${EXP}, ${Q}})`, legend: '{{queue}} long' },
  ], { unit: 'µs', w: 8, h: 6 }),
  ts('Uncommitted messages / expired (per 2m)', [
    { expr: `max by (queue)(ibmmq_queue_uncommitted_messages{${EXP}, ${Q}})`, legend: '{{queue}} uncommitted' },
    { expr: `sum by (queue)(sum_over_time(ibmmq_queue_expired_messages{${EXP}, ${Q}}[2m]))`, legend: '{{queue}} expired/2m' },
  ], { w: 8, h: 6 }),
  table('Queue snapshot', [
    { expr: `max by (queue)(ibmmq_queue_depth{${EXP}, ${Q}})`, instant: true, format: 'table' },
    { expr: `max by (queue)(ibmmq_queue_attribute_max_depth{${EXP}, ${Q}})`, instant: true, format: 'table' },
    { expr: `max by (queue)(ibmmq_queue_oldest_message_age{${EXP}, ${Q}})`, instant: true, format: 'table' },
    { expr: `max by (queue)(ibmmq_queue_input_handles{${EXP}, ${Q}})`, instant: true, format: 'table' },
    { expr: `max by (queue)(ibmmq_queue_output_handles{${EXP}, ${Q}})`, instant: true, format: 'table' },
  ], { w: 8, h: 6, transformations: [
    { id: 'merge', options: {} },
    { id: 'organize', options: { excludeByName: { Time: true }, renameByName: { queue: 'queue', 'Value #A': 'depth', 'Value #B': 'MAXDEPTH', 'Value #C': 'oldest age (s)', 'Value #D': 'input handles', 'Value #E': 'output handles' } } },
  ] }),

  // ---- Channels & connections
  row('🔌 Channels & connections'),
  ts('Channel status (0 stopped · 1 transition · 2 running)', [{ expr: `max by (channel, type)(ibmmq_channel_status_squash{${EXP}})`, legend: '{{channel}} ({{type}})' }], { min: 0, max: 2, w: 12, h: 6 }),
  ts('Channel instances', [{ expr: `max by (channel)(ibmmq_channel_cur_inst{${EXP}})`, legend: '{{channel}}' }], { w: 12, h: 6 }),
  ts('Channel messages / s', [{ expr: `sum by (channel)(rate(ibmmq_channel_messages{${EXP}}[2m]))`, legend: '{{channel}}' }], { unit: 'ops', w: 12, h: 6 }),
  ts('Channel bytes / s (sent + received)', [
    { expr: `sum by (channel)(rate(ibmmq_channel_bytes_sent{${EXP}}[2m]))`, legend: '{{channel}} sent' },
    { expr: `sum by (channel)(rate(ibmmq_channel_bytes_rcvd{${EXP}}[2m]))`, legend: '{{channel}} rcvd' },
  ], { unit: 'Bps', w: 12, h: 6 }),

  // ---- Canary & orders flow
  row('🐤 Canary & orders flow'),
  stat('Canary attempts (1h)', 'sum(increase(mq_canary_attempts_total[1h]))', { decimals: 0, w: 4 }),
  stat('Canary failures (1h)', 'sum(increase(mq_canary_attempts_total{result!="ok"}[1h])) or vector(0)', { thresholds: green(5, 1), decimals: 0, w: 4 }),
  stat('Canary p50 RTT', 'histogram_quantile(0.5, sum by (le)(rate(mq_canary_roundtrip_duration_seconds_bucket[5m])))', { unit: 's', decimals: 3, w: 4 }),
  stat('Orders produced (1h)', 'sum(increase(mq_orders_produced_total[1h]))', { decimals: 0, w: 4 }),
  stat('Orders consumed (1h)', 'sum(increase(mq_orders_consumed_total[1h]))', { decimals: 0, w: 4 }),
  stat('Order put errors (1h)', 'sum(increase(mq_orders_put_errors_total[1h])) or vector(0)', { thresholds: green(10, 1), decimals: 0, w: 4 }),
  ts('Canary attempts by result', [{ expr: 'sum by (result)(rate(mq_canary_attempts_total[2m]))', legend: '{{result}}' }], { unit: 'ops', w: 12, h: 6 }),
  ts('Canary round-trip (p50 / p99)', [
    { expr: 'histogram_quantile(0.5, sum by (le)(rate(mq_canary_roundtrip_duration_seconds_bucket[5m])))', legend: 'p50' },
    { expr: 'ibmmq:canary_roundtrip:p99_5m', legend: 'p99' },
  ], { unit: 's', w: 12, h: 6 }),
  ts('Orders flow: produced vs consumed', [
    { expr: 'sum(rate(mq_orders_produced_total[2m]))', legend: 'produced/s' },
    { expr: 'sum(rate(mq_orders_consumed_total[2m]))', legend: 'consumed/s' },
    { expr: 'sum(rate(mq_orders_put_errors_total[2m]))', legend: 'put errors/s' },
  ], { unit: 'ops', w: 12, h: 6 }),
  ts('APP.ORDERS.REQ depth and oldest age', [
    { expr: `max(ibmmq_queue_depth{${EXP}, queue="APP.ORDERS.REQ"})`, legend: 'depth' },
    { expr: `max(ibmmq_queue_oldest_message_age{${EXP}, queue="APP.ORDERS.REQ"})`, legend: 'oldest age (s)' },
  ], { w: 12, h: 6 }),

  // ---- Queue manager resources (native endpoint)
  row('🖥️ Queue manager resources'),
  stat('User CPU', `max(ibmmq_qmgr_user_cpu_time_percentage{${NAT}})`, { unit: 'percent', thresholds: green(90, 70), decimals: 1, w: 4 }),
  stat('RAM free', `max(ibmmq_qmgr_ram_free_percentage{${NAT}})`, { unit: 'percent', thresholds: redBelow(20, 10), decimals: 1, w: 4 }),
  stat('QMgr filesystem free', `max(ibmmq_qmgr_queue_manager_file_system_free_space_percentage{${NAT}})`, { unit: 'percent', thresholds: redBelow(25, 15), decimals: 1, w: 4 }),
  stat('Log filesystem free', `max(ibmmq_qmgr_log_file_system_free_space_percentage{${NAT}})`, { unit: 'percent', thresholds: redBelow(25, 15), decimals: 1, w: 4 }),
  stat('Log primary space in use', `max(ibmmq_qmgr_log_primary_space_in_use_percentage{${NAT}})`, { unit: 'percent', thresholds: green(90, 70), decimals: 1, w: 4 }),
  stat('Log write latency', `max(ibmmq_qmgr_log_write_latency_seconds{${NAT}})`, { unit: 's', thresholds: green(0.05, 0.02), decimals: 4, w: 4 }),
  ts('CPU: user / system (%)', [
    { expr: `max(ibmmq_qmgr_user_cpu_time_percentage{${NAT}})`, legend: 'user' },
    { expr: `max(ibmmq_qmgr_system_cpu_time_percentage{${NAT}})`, legend: 'system' },
  ], { unit: 'percent', w: 12, h: 6 }),
  ts('MQI calls / s (qmgr)', [
    { expr: `sum(rate(ibmmq_qmgr_mqput_mqput1_total{${NAT}}[2m]))`, legend: 'mqput' },
    { expr: `sum(rate(ibmmq_qmgr_destructive_get_total{${NAT}}[2m]))`, legend: 'destructive get' },
    { expr: `sum(rate(ibmmq_qmgr_commit_total{${NAT}}[2m]))`, legend: 'commit' },
    { expr: `sum(rate(ibmmq_qmgr_rollback_total{${NAT}}[2m]))`, legend: 'rollback' },
    { expr: `sum(rate(ibmmq_qmgr_mqconn_mqconnx_total{${NAT}}[2m]))`, legend: 'connect' },
  ], { unit: 'ops', w: 12, h: 6 }),
  ts('Failed MQI calls / s and expired messages', [
    { expr: `sum(rate(ibmmq_qmgr_failed_mqput_total{${NAT}}[2m]))`, legend: 'failed mqput' },
    { expr: `sum(rate(ibmmq_qmgr_failed_mqget_total{${NAT}}[2m]))`, legend: 'failed mqget' },
    { expr: `sum(rate(ibmmq_qmgr_failed_mqopen_total{${NAT}}[2m]))`, legend: 'failed mqopen' },
    { expr: `sum(rate(ibmmq_qmgr_failed_mqconn_mqconnx_total{${NAT}}[2m]))`, legend: 'failed connect' },
    { expr: `sum(rate(ibmmq_qmgr_expired_message_total{${NAT}}[2m]))`, legend: 'expired' },
  ], { unit: 'ops', w: 12, h: 6 }),
  ts('Persistent vs non-persistent puts / s', [
    { expr: `sum(rate(ibmmq_qmgr_persistent_message_mqput_total{${NAT}}[2m]) + rate(ibmmq_qmgr_persistent_message_mqput1_total{${NAT}}[2m]))`, legend: 'persistent' },
    { expr: `sum(rate(ibmmq_qmgr_non_persistent_message_mqput_total{${NAT}}[2m]) + rate(ibmmq_qmgr_non_persistent_message_mqput1_total{${NAT}}[2m]))`, legend: 'non-persistent' },
  ], { unit: 'ops', w: 12, h: 6 }),
  ts('Recovery log written / s (logical vs physical)', [
    { expr: `sum(rate(ibmmq_qmgr_log_logical_written_bytes_total{${NAT}}[2m]))`, legend: 'logical' },
    { expr: `sum(rate(ibmmq_qmgr_log_physical_written_bytes_total{${NAT}}[2m]))`, legend: 'physical' },
  ], { unit: 'Bps', w: 12, h: 6 }),
  ts('Recovery log: write latency and size in use', [
    { expr: `max(ibmmq_qmgr_log_write_latency_seconds{${NAT}})`, legend: 'write latency (s)' },
    { expr: `max(ibmmq_qmgr_log_in_use_bytes{${NAT}}) / max(ibmmq_qmgr_log_max_bytes{${NAT}})`, legend: 'in use / max' },
  ], { w: 12, h: 6 }),

  // ---- Alerts
  row('🚨 Alerts'),
  stat('Symptom alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", burn_rate="", kind=""}) or vector(0)', { thresholds: green(1, 1), decimals: 0, w: 4 }),
  stat('Burn-rate alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", burn_rate!=""}) or vector(0)', { thresholds: green(1, 1), decimals: 0, w: 4 }),
  stat('Forecast alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", kind="forecast"}) or vector(0)', { thresholds: green(1, 1), decimals: 0, w: 4 }),
  table('Firing pack alerts', [{ expr: 'ALERTS{pack="ibmmq", alertstate="firing"}', instant: true, format: 'table' }], { w: 12, h: 8, transformations: [
    { id: 'organize', options: { excludeByName: { Time: true, Value: true, __name__: true, pack: true, service: true, alertstate: true }, indexByName: { alertname: 0, severity: 1, slo: 2, sli: 3, qmgr: 4, queue: 5 } } },
  ] }),
  ts('Burn-rate / forecast alerts (1 = pending, 2 = firing)', [
    { expr: '(2 * max by (alertname) (ALERTS{pack="ibmmq", alertstate="firing", burn_rate!=""})) or max by (alertname) (ALERTS{pack="ibmmq", alertstate="pending", burn_rate!=""})', legend: '{{alertname}}' },
    { expr: '(2 * max by (alertname) (ALERTS{pack="ibmmq", alertstate="firing", kind="forecast"})) or max by (alertname) (ALERTS{pack="ibmmq", alertstate="pending", kind="forecast"})', legend: '{{alertname}}' },
  ], { min: 0, max: 2, w: 12, h: 8, legend: 'table' }),

  // ---- Logs & traces
  row('📜 Logs & 🔍 Traces'),
  logs('Logs · queue manager and apps (filter with the "service" variable)', `{${LOGSVC}}`, { w: 24, h: 9 }),
  traces('Recent traces (producer → consumer through MQ; open a consumer receive span for the producer link)', '{ resource.service.name =~ "mq-canary|orders-producer|orders-consumer" }', { w: 24, h: 8 }),

  // ---- Telemetry pipeline
  row('🔭 Telemetry pipeline'),
  ts('Collector: exported per second', [
    { expr: 'sum by (exporter)(rate(otelcol_exporter_sent_metric_points_total[2m]))', legend: 'metric points → {{exporter}}' },
    { expr: 'sum by (exporter)(rate(otelcol_exporter_sent_log_records_total[2m]))', legend: 'log records → {{exporter}}' },
    { expr: 'sum by (exporter)(rate(otelcol_exporter_sent_spans_total[2m]))', legend: 'spans → {{exporter}}' },
  ], { unit: 'ops', w: 8, h: 6 }),
  ts('Collector: export failures per second', [
    { expr: 'sum by (exporter)(rate(otelcol_exporter_send_failed_metric_points_total[2m])) or vector(0)', legend: 'metric points {{exporter}}' },
    { expr: 'sum by (exporter)(rate(otelcol_exporter_send_failed_log_records_total[2m])) or vector(0)', legend: 'log records {{exporter}}' },
    { expr: 'sum by (exporter)(rate(otelcol_exporter_send_failed_spans_total[2m])) or vector(0)', legend: 'spans {{exporter}}' },
  ], { unit: 'ops', w: 8, h: 6 }),
  ts('Scrape duration by MQ job', [{ expr: 'max by (job)(scrape_duration_seconds{job=~"ibmmq-.*"})', legend: '{{job}}' }], { unit: 's', w: 8, h: 6 }),
];
const unified = dashboard('ibmmq-unified', 'IBM MQ — Unified Observability', flow(items).panels, ['ibmmq', 'pack', 'unified'], {
  time: { from: 'now-3h', to: 'now' },
  templating: { list: [
    { name: 'queue', label: 'Queue', type: 'query', datasource: DS, refresh: 2, sort: 1, multi: true, includeAll: true, allValue: '.*',
      query: { query: 'label_values(ibmmq_queue_depth{job="ibmmq-exporter"}, queue)', refId: 'StandardVariableQuery' },
      definition: 'label_values(ibmmq_queue_depth{job="ibmmq-exporter"}, queue)', current: { text: 'All', value: '$__all', selected: true }, options: [] },
    { name: 'service', label: 'Log service', type: 'custom', multi: true, includeAll: true, allValue: '.+',
      query: 'ibmmq,mq-canary,orders-producer,orders-consumer',
      options: ['ibmmq', 'mq-canary', 'orders-producer', 'orders-consumer'].map(v => ({ text: v, value: v, selected: false })),
      current: { text: 'All', value: '$__all', selected: true } },
  ] },
});

writeFileSync('stack/grafana/dashboards/ibmmq-overview.json', JSON.stringify(overview, null, 2) + '\n');
writeFileSync('stack/grafana/dashboards/ibmmq-queues.json', JSON.stringify(queues, null, 2) + '\n');
writeFileSync('stack/grafana/dashboards/ibmmq-slo-burn.json', JSON.stringify(sloBurn, null, 2) + '\n');
writeFileSync('stack/grafana/dashboards/ibmmq-unified.json', JSON.stringify(unified, null, 2) + '\n');
console.log('dashboards written');
