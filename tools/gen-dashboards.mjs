#!/usr/bin/env node
// Generates stack/grafana/dashboards/*.json from a compact panel spec so the dashboards stay
// reviewable in a diff. Pack bindings (packs/ibmmq.pack.yaml panel_bindings) live in each
// panel's `pack.binds_to` array (tools/check-rules.mjs reads it; the legacy
// `description: "binds_to: …"` form is still accepted), so `description` is for humans.
//
// The unified board follows the pack's own structure (the Kafka reference pack's order):
// §1-2 SLIs and SLOs → §10 baselines & validation (MTTD, MTTR, certification, synthetic) →
// §7-8 policy and alerting → §9 remediation → the signals behind the SLIs → §3-5 pipelines,
// storage and queries → logs and traces. What matters is at the top: SLOs, MTTD, MTTR.
//
// Visual system (shared by all four boards):
//   * one calm palette (C) for series, thresholds and state colours; thresholds colour the
//     VALUE of a stat, not a wall of green tiles; status tiles are the only solid ones;
//   * stats carry a sparkline of the same series; gauges for bounded resources; bar gauges for
//     "how close to the limit" views (headroom by queue, burn per SLO, MTTD per alert vs target);
//   * state timelines for anything that is a state over time (qmgr/channel status, alert
//     pending/firing) instead of 0/1/2 line charts;
//   * time series: smooth lines, soft gradient fill, nulls bridged across the exporter's
//     publication gaps, dashed SLO threshold lines, table legends with last/max where there
//     are many series, semantic colours (produced blue, consumed green, errors red …);
//   * a header banner with cross-board navigation; rows without emoji; annotations only for
//     symptom alerts (burn alerts painted every graph red for an hour after each incident).
// Layout is computed by flow(): add panels in reading order, never by coordinates.
import { writeFileSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from '../vendor/observogram/lib/mini-yaml.mjs';
const pack = parseYaml(readFileSync('packs/ibmmq.pack.yaml', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const PACK_VERSION = pack.metadata.version;
const REPO_URL = `https://github.com/${String(pkg.repository || '').replace(/^github:/, '')}/blob/main`;
const DS = { type: 'prometheus', uid: 'prom' };
const LOKI = { type: 'loki', uid: 'loki' };
const TEMPO = { type: 'tempo', uid: 'tempo' };
const secondsOf = (d) => { const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(String(d).trim()); if (!m) throw new Error(`duration ${d}`); return Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[m[2]]; };
const BASE = { mttdP50: secondsOf(pack.spec.baselines.mttd_target_p50), mttdP95: secondsOf(pack.spec.baselines.mttd_target_p95), mttrP50: secondsOf(pack.spec.baselines.mttr_target_p50), mttrP95: secondsOf(pack.spec.baselines.mttr_target_p95) };

// ---------------------------------------------------------------- palette & thresholds
const C = { blue: '#5B8DEF', green: '#3DD68C', amber: '#F5B14C', red: '#F0616D', violet: '#A78BFA', cyan: '#38BDF8', slate: '#8B98A9', pink: '#F472B6', teal: '#2DD4BF', dim: '#4B5563' };
const okAbove = (warn, bad) => [{ color: C.green, value: null }, { color: C.amber, value: warn }, { color: C.red, value: bad }];   // higher is worse
const okBelow = (warn, bad) => [{ color: C.red, value: null }, { color: C.amber, value: bad }, { color: C.green, value: warn }];   // lower is worse
const neutral = [{ color: C.slate, value: null }];
const fixed = (color) => ({ mode: 'fixed', fixedColor: color });
// Burn-rate colours come from the SLO's own policy windows (amber at the smallest factor that
// alerts, red at the largest); a fixed 6×/14× stayed green while message_age's 4× alert fired.
function burnFactors(sloId) {
  const f = (pack.spec.policy?.burn_rate_alerts || []).filter(b => b.slo === sloId).flatMap(b => (b.windows || []).map(w => Number(w.factor))).filter(Number.isFinite);
  return f.length ? { warn: Math.min(...f), bad: Math.max(...f) } : { warn: 6, bad: 14 };
}
const burnThresholds = (sloId) => { const { warn, bad } = burnFactors(sloId); return okAbove(warn, bad); };
const SLO_LABEL = {
  qmgr_process_up_99_9: 'Process up · 99.9 %', qmgr_reachability_99_9: 'Reachable · 99.9 %', queue_headroom_99_9: 'Queue headroom · 99.9 %',
  message_age_99_under_60s: 'Message age < 60 s · 99 %', dlq_empty_99_9: 'DLQ empty · 99.9 %', canary_success_99_9: 'Canary success · 99.9 %',
  canary_latency_99_p99_500ms: 'Canary p99 < 500 ms · 99 %', log_latency_99_under_20ms: 'Log latency < 20 ms · 99 %',
};
for (const s of pack.spec.slos) if (!SLO_LABEL[s.id]) throw new Error(`no label for SLO ${s.id}`);
const SLO_RENAME = Object.fromEntries(Object.entries(SLO_LABEL).map(([id, l]) => [id, l.replace(/ · .*$/, '')]));

// ---------------------------------------------------------------- panel factories
let nextId = 1;
const refIds = (i) => String.fromCharCode(65 + i);
function base(type, title, { binds, desc, w = 12, h = 8, datasource = DS } = {}, extra) {
  const bindsArr = binds ? (Array.isArray(binds) ? binds : [binds]) : null;
  return { id: nextId++, type, title, datasource, gridPos: { x: 0, y: 0, w, h }, ...(desc ? { description: desc } : {}), ...(bindsArr ? { pack: { binds_to: bindsArr } } : {}), ...extra };
}
const props = (o) => Object.entries(o).map(([id, value]) => ({ id, value }));
const byName = (name, o) => ({ matcher: { id: 'byName', options: name }, properties: props(o) });
const byRegexp = (re, o) => ({ matcher: { id: 'byRegexp', options: re }, properties: props(o) });
const colorOverrides = (colors = {}) => Object.entries(colors).map(([n, c]) => (n.startsWith('/') ? byRegexp(n.slice(1, -1), { color: fixed(c) }) : byName(n, { color: fixed(c) })));

/** Single value. mode: 'value' (coloured number + sparkline), 'solid' (status tile), 'none' (informational). */
function stat(title, expr, { binds, desc, unit = 'none', decimals, thresholds, mappings, mode = 'value', spark = true, w = 4, h = 4 } = {}) {
  const colorMode = mode === 'solid' ? 'background_solid' : mode === 'none' ? 'none' : 'value';
  const range = mode !== 'solid' && spark;
  return base('stat', title, { binds, desc, w, h }, {
    targets: [{ refId: 'A', expr, instant: !range, range, legendFormat: '__auto' }],
    fieldConfig: { defaults: { unit, decimals, mappings: mappings || [], color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: thresholds || neutral } }, overrides: [] },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode, graphMode: range ? 'area' : 'none', textMode: 'value', justifyMode: 'center', wideLayout: true, orientation: 'auto', showPercentChange: false },
  });
}
/** Radial gauge for a bounded quantity (0-100 % resources). */
function gauge(title, expr, { desc, unit = 'percent', min = 0, max = 100, decimals = 0, thresholds, w = 4, h = 5 } = {}) {
  return base('gauge', title, { desc, w, h }, {
    targets: [{ refId: 'A', expr, instant: true }],
    fieldConfig: { defaults: { unit, min, max, decimals, color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: thresholds || neutral } }, overrides: [] },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, orientation: 'auto', showThresholdLabels: false, showThresholdMarkers: true, sizing: 'auto', minVizWidth: 75, minVizHeight: 75 },
  });
}
/** Horizontal bars, one per series: how close each item is to its limit. */
function bargauge(title, expr, { binds, desc, legend = '__auto', unit = 'none', min = 0, max, decimals, thresholds, overrides = [], w = 12, h = 8 } = {}) {
  return base('bargauge', title, { binds, desc, w, h }, {
    targets: [{ refId: 'A', expr, instant: true, legendFormat: legend }],
    fieldConfig: { defaults: { unit, min, max, decimals, color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: thresholds || neutral } }, overrides },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, orientation: 'horizontal', displayMode: 'gradient', valueMode: 'color', namePlacement: 'left', showUnfilled: true, sizing: 'auto', minVizWidth: 8, minVizHeight: 14, maxVizHeight: 26, legend: { showLegend: false } },
  });
}
/**
 * Time series. legend: 'list' | 'table' | 'hidden' | 'auto' (table with last/max when ≥ 12 wide
 * and `many` series are expected). `lines` draws dashed threshold lines. `colors` maps
 * series display names (or "/regex/") to fixed colours. `rename` maps display names.
 */
function ts(title, targets, { binds, desc, unit = 'none', decimals, min, max, w = 12, h = 7, legend = 'auto', many = false, lines, colors, rename, step = false, stack = false, axisRight = [], fill = 10, softMin = 0 } = {}) {
  const legendMode = legend === 'auto' ? (many && w >= 12 ? 'table' : 'list') : legend;
  const overrides = [
    ...colorOverrides(colors),
    ...Object.entries(rename || {}).map(([n, d]) => byName(n, { displayName: d })),
    ...axisRight.map(a => byName(a.name, { unit: a.unit, 'custom.axisPlacement': 'right', ...(a.min != null ? { min: a.min } : {}), ...(a.max != null ? { max: a.max } : {}) })),
  ];
  return base('timeseries', title, { binds, desc, w, h }, {
    targets: targets.map((t, i) => ({ refId: refIds(i), expr: t.expr, legendFormat: t.legend || '__auto' })),
    fieldConfig: {
      defaults: {
        unit, decimals, min, max, color: { mode: 'palette-classic' },
        custom: {
          drawStyle: 'line', lineInterpolation: step ? 'stepAfter' : 'smooth', lineWidth: 2, fillOpacity: stack ? 30 : fill, gradientMode: 'opacity',
          showPoints: 'never', pointSize: 4, spanNulls: 30000, axisBorderShow: false, axisSoftMin: softMin, axisPlacement: 'auto',
          stacking: { mode: stack ? 'normal' : 'none', group: 'A' },
          thresholdsStyle: { mode: lines ? 'dashed' : 'off' },
        },
        thresholds: { mode: 'absolute', steps: lines ? [{ color: 'transparent', value: null }, ...lines.map(l => ({ color: l.color || C.amber, value: l.value }))] : [{ color: C.green, value: null }] },
      },
      overrides,
    },
    options: {
      legend: legendMode === 'hidden' ? { showLegend: false, displayMode: 'list', placement: 'bottom', calcs: [] }
        : { showLegend: true, displayMode: legendMode, placement: legendMode === 'table' ? 'right' : 'bottom', calcs: legendMode === 'table' ? ['lastNotNull', 'max'] : [] },
      tooltip: { mode: 'multi', sort: 'desc' },
    },
  });
}
/**
 * State over time (status codes, alert pending/firing). `mappings` colour and label the states.
 * Colour scheme must be a FIXED colour: with `thresholds` Grafana 12 derives the timeline's
 * states from the threshold steps and ignores value-mapping colours (every row rendered as a
 * grey "—"; verified with a side-by-side test dashboard).
 */
function timeline(title, targets, { binds, desc, mappings, overrides = [], w = 12, h = 6, legend = true } = {}) {
  return base('state-timeline', title, { binds, desc, w, h }, {
    targets: targets.map((t, i) => ({ refId: refIds(i), expr: t.expr, legendFormat: t.legend || '__auto' })),
    fieldConfig: { defaults: { color: { mode: 'fixed', fixedColor: C.dim }, mappings: mappings || [], custom: { lineWidth: 0, fillOpacity: 78 } }, overrides },
    options: { mergeValues: true, showValue: 'never', alignValue: 'center', rowHeight: 0.82, legend: { showLegend: legend, displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'single', sort: 'none' } },
  });
}
function table(title, targets, { binds, desc, w = 12, h = 8, datasource = DS, transformations = [], overrides = [], sortBy } = {}) {
  return base('table', title, { binds, desc, w, h, datasource }, {
    targets: targets.map((t, i) => ({ refId: refIds(i), datasource, ...t })),
    transformations,
    fieldConfig: { defaults: { custom: { align: 'auto', cellOptions: { type: 'auto' }, filterable: false } }, overrides },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false, reducer: ['sum'], countRows: false, fields: '' }, ...(sortBy ? { sortBy: [sortBy] } : {}) },
  });
}
function traces(title, traceql, { desc, w = 24, h = 8, limit = 20 } = {}) {
  return base('table', title, { desc, w, h, datasource: TEMPO }, {
    targets: [{ refId: 'A', datasource: TEMPO, queryType: 'traceql', query: traceql, limit, tableType: 'traces' }],
    options: { showHeader: true, cellHeight: 'sm' },
  });
}
function logs(title, expr, { desc, w = 24, h = 9 } = {}) {
  return base('logs', title, { desc, w, h, datasource: LOKI }, {
    targets: [{ refId: 'A', expr }],
    options: { showTime: true, showLabels: false, showCommonLabels: false, wrapLogMessage: true, prettifyLogMessage: false, enableLogDetails: true, dedupStrategy: 'none', sortOrder: 'Descending' },
  });
}
function row(title) { return base('row', title, { w: 24, h: 1, datasource: undefined }, { collapsed: false, panels: [] }); }
function text(content, { title = '', w = 24, h = 4, transparent = false } = {}) {
  return base('text', title, { w, h, datasource: undefined }, { transparent, options: { mode: 'markdown', content, code: { language: 'plaintext', showLineNumbers: false, showMiniMap: false } } });
}
/** Header banner: what the board is, pack version, and the other boards. */
function header(name, blurb, uid) {
  const boards = [['ibmmq-unified', 'Unified'], ['ibmmq-overview', 'Overview'], ['ibmmq-queues', 'Queues & channels'], ['ibmmq-slo-burn', 'SLO burn']];
  const nav = boards.map(([u, t]) => (u === uid ? `**${t}**` : `[${t}](/d/${u}?${'$'}{__url_time_range})`)).join(' · ');
  return text(`### IBM MQ · ${name}\n${blurb} &nbsp;·&nbsp; pack \`ibmmq@${PACK_VERSION}\` &nbsp;·&nbsp; ${nav}`, { h: 2, transparent: true });
}
// Flow layout: left-to-right in 24-column lines in the order given; a row always starts a line.
function flow(items, startY = 0) {
  let x = 0, y = startY, lineH = 0;
  for (const p of items) {
    const w = p.type === 'row' ? 24 : p.gridPos.w, h = p.type === 'row' ? 1 : p.gridPos.h;
    if (p.type === 'row' || x + w > 24) { x = 0; y += lineH; lineH = 0; }
    p.gridPos = { x, y, w, h };
    x += w; lineH = Math.max(lineH, h);
    if (p.type === 'row') { x = 0; y += 1; lineH = 0; }
  }
  return items;
}
function dashboard(uid, title, panels, tags, { templating = { list: [] }, time = { from: 'now-1h', to: 'now' }, description } = {}) {
  const links = [['ibmmq-unified', 'Unified'], ['ibmmq-overview', 'Overview'], ['ibmmq-queues', 'Queues & channels'], ['ibmmq-slo-burn', 'SLO burn']]
    .filter(([u]) => u !== uid).map(([u, t]) => ({ title: t, type: 'link', url: `/d/${u}`, icon: 'dashboard', keepTime: true, includeVars: false, targetBlank: false, asDropdown: false, tags: [] }));
  return {
    uid, title, description, tags, timezone: 'browser', schemaVersion: 41, version: 1, editable: true, graphTooltip: 1, liveNow: false, refresh: '30s',
    fiscalYearStartMonth: 0, weekStart: '',
    timepicker: { refresh_intervals: ['10s', '30s', '1m', '5m', '15m'] },
    time, templating,
    annotations: { list: [
      // symptom alerts only: burn-rate alerts keep firing for hours after an incident and painted
      // every graph red; the policy row has its own timeline for them
      { name: 'Symptom alerts', datasource: DS, enable: true, hide: false, iconColor: C.red, expr: 'ALERTS{alertstate="firing", pack="ibmmq", burn_rate="", kind=""}', step: '10s', titleFormat: '{{alertname}}', textFormat: '{{severity}} · {{qmgr}} {{queue}}' },
    ] },
    links, panels: flow(panels),
  };
}

// ---------------------------------------------------------------- shared building blocks
const EXP = 'job="ibmmq-exporter"', NAT = 'job="ibmmq-native"', Q = 'queue=~"$queue"';
const STATE_QMGR = [{ type: 'value', options: { '2': { text: 'RUNNING', color: C.green }, '0': { text: 'UNREACHABLE', color: C.red }, '1': { text: 'STARTING', color: C.amber }, '3': { text: 'QUIESCING', color: C.amber } } }];
const STATE_SERVICE = [{ type: 'value', options: { '2': { text: 'RUNNING', color: C.green }, '1': { text: 'STARTING', color: C.amber }, '0': { text: 'STOPPED', color: C.red } } }];
const STATE_UPDOWN = [{ type: 'value', options: { '1': { text: 'UP', color: C.green }, '0': { text: 'DOWN', color: C.red } } }];
const STATE_CHANNEL = [{ type: 'value', options: { '2': { text: 'RUNNING', color: C.green }, '1': { text: 'TRANSITION', color: C.amber }, '0': { text: 'INACTIVE / STOPPED', color: C.slate } } }];
const STATE_ALERT = [{ type: 'value', options: { '2': { text: 'FIRING', color: C.red }, '1': { text: 'PENDING', color: C.amber }, '0': { text: 'quiet', color: '#1E3A34' } } }];
const STATE_VERDICT = [{ type: 'value', options: { '0': { text: 'PASS', color: C.green }, '1': { text: 'WARN', color: C.amber }, '2': { text: 'FAIL', color: C.red }, '3': { text: 'ERROR', color: C.red } } }];
const RESULT_COLORS = { ok: C.green, get_timeout: C.amber, connect_failed: C.red, payload_mismatch: C.pink, put_failed_q_full: C.violet, auth_failed: C.red, handle_invalid: C.amber, message_too_large: C.violet, error: C.red };
// 2 = firing, 1 = pending per alertname; the trailing "no alert" row is always present at 0
// so a quiet period renders as a calm baseline instead of Grafana's "no time field" notice.
const alertState = (sel, baseline = true) => `(2 * max by (alertname) (ALERTS{pack="ibmmq", alertstate="firing", ${sel}})) or max by (alertname) (ALERTS{pack="ibmmq", alertstate="pending", ${sel}})${baseline ? ' or label_replace(vector(0), "alertname", "no alert", "", "")' : ''}`;
const CERT = 'job="certification"';

const sliTiles = () => [
  stat('Process up', 'ibmmq:qmgr_process_up:ratio_5m', { binds: 'slis.qmgr_process_up', desc: '5-minute fraction of scrapes in which the queue manager\'s native metrics endpoint answered. SLO 99.9 % over 30 d.', unit: 'percentunit', decimals: 2, thresholds: okBelow(0.999, 0.99), w: 3 }),
  stat('Reachable', 'ibmmq:qmgr_reachability:ratio_5m', { binds: 'slis.qmgr_reachability', desc: '5-minute fraction of samples in which an MQ client (the exporter over DEV.ADMIN.SVRCONN) saw the queue manager RUNNING. Diverges from "process up" on listener, channel, CHLAUTH or CONNAUTH faults.', unit: 'percentunit', decimals: 2, thresholds: okBelow(0.999, 0.99), w: 3 }),
  stat('Queue headroom', 'max(ibmmq:queue_depth_headroom:ratio)', { binds: 'slis.queue_depth_headroom', desc: 'Highest depth / MAXDEPTH across application queues. 100 % means producers get MQRC_Q_FULL (2053).', unit: 'percentunit', decimals: 1, thresholds: okAbove(0.8, 1), w: 3 }),
  stat('Oldest message', 'max(ibmmq:oldest_message_age:seconds_max)', { binds: 'slis.oldest_message_age', desc: 'Age of the oldest message on any application queue (DLQ excluded). Consumer health.', unit: 's', decimals: 0, thresholds: okAbove(60, 120), w: 3 }),
  stat('DLQ depth', 'ibmmq:dlq_depth:max', { binds: 'slis.dlq_depth', desc: 'Messages on the queue manager\'s dead-letter queue (APP.DLQ).', decimals: 0, thresholds: okAbove(1, 10), w: 3 }),
  stat('Canary success', 'ibmmq:canary_success:ratio_5m', { binds: 'slis.canary_success', desc: '5-minute success ratio of the synthetic put→get probe on APP.CANARY (matching payload within 5 s).', unit: 'percentunit', decimals: 2, thresholds: okBelow(0.999, 0.99), w: 3 }),
  stat('Canary p99', 'ibmmq:canary_roundtrip:p99_5m', { binds: 'slis.canary_roundtrip_p99', desc: 'p99 put→get round-trip of successful probes over 5 minutes (connect time excluded).', unit: 's', decimals: 1, thresholds: okAbove(0.5, 1), w: 3 }),
  stat('Log write latency', 'ibmmq:log_write_latency:seconds', { binds: 'slis.log_write_latency', desc: 'Recovery-log write latency reported by the queue manager. Persistent-message throughput depends on it.', unit: 's', decimals: 1, thresholds: okAbove(0.02, 0.05), w: 3 }),
];
const burnBars = (binds, w = 12, h = 8) => bargauge('Error-budget burn · last hour', 'ibmmq:errorbudget:burn_1h', {
  binds, legend: '{{slo}}', decimals: 1, min: 0, max: 20, w, h,
  desc: '1 h error-budget burn rate per SLO: 1× consumes the budget exactly over the SLO window; amber at the smallest factor that alerts for that SLO, red at the largest (spec.policy).',
  overrides: pack.spec.slos.map(s => { const { warn, bad } = burnFactors(s.id); return byName(s.id, { displayName: SLO_LABEL[s.id], thresholds: { mode: 'absolute', steps: okAbove(warn, bad) } }); }),
});
const burnCurves = (w, legend = 'auto') => [
  ts('Burn rate · 5 m window', [{ expr: 'ibmmq:errorbudget:burn_5m', legend: '{{slo}}' }], { desc: 'Fast window: reacts within minutes; pages when both it and the slow window exceed the factor. Hover for per-SLO values.', unit: 'short', decimals: 1, w, h: 8, legend, rename: SLO_RENAME, lines: [{ value: 1, color: C.slate }, { value: 14, color: C.red }] }),
  ts('Burn rate · 1 h window', [{ expr: 'ibmmq:errorbudget:burn_1h', legend: '{{slo}}' }], { desc: 'Slow window: keeps burning for up to an hour after an incident by design.', unit: 'short', decimals: 1, w, h: 8, legend, rename: SLO_RENAME, lines: [{ value: 1, color: C.slate }, { value: 6, color: C.red }] }),
];
const alertTimelines = (w, h) => [
  timeline('Symptom alerts · pending / firing', [{ expr: alertState('burn_rate="", kind=""'), legend: '{{alertname}}' }], { desc: 'State of every symptom alert of the pack over the time range.', mappings: STATE_ALERT, w, h, legend: false }),
  timeline('Burn-rate & forecast alerts · pending / firing', [{ expr: alertState('burn_rate!=""'), legend: '{{alertname}}' }, { expr: alertState('kind="forecast"', false), legend: '{{alertname}}' }], { desc: 'Multi-window burn-rate alerts (fast windows page, slow windows linger after incidents) and forecasts.', mappings: STATE_ALERT, w, h, legend: false }),
];
const alertTable = (w, h) => table('Firing pack alerts', [{ expr: 'ALERTS{pack="ibmmq", alertstate="firing"}', instant: true, format: 'table' }], {
  desc: 'Everything currently firing with the pack label, most severe first.', w, h, sortBy: { displayName: 'severity', desc: false },
  transformations: [{ id: 'organize', options: { excludeByName: { Time: true, Value: true, __name__: true, pack: true, service: true, alertstate: true, instance: true, job: true }, indexByName: { alertname: 0, severity: 1, slo: 2, sli: 3, qmgr: 4, queue: 5 } } }],
  overrides: [byName('severity', { 'custom.cellOptions': { type: 'color-background', mode: 'basic' }, 'custom.width': 80, mappings: [{ type: 'value', options: { SEV1: { color: C.red, text: 'SEV1' }, SEV2: { color: C.amber, text: 'SEV2' }, SEV3: { color: C.blue, text: 'SEV3' } } }] }), byName('alertname', { 'custom.width': 300 })],
});
// §10 baselines & validation: what the harness measured in the last certification run
// (published to the alert-sink, scraped as job "certification").
const fmtS = (s) => (s >= 60 ? `${s / 60} min` : `${s} s`);
const certTiles = () => [
  stat('Last certification', `max(mq_cert_verdict_code{${CERT}})`, { desc: 'Verdict of the last `npm run certify` published to the alert-sink: PASS, WARN, FAIL or ERROR.', mappings: STATE_VERDICT, mode: 'solid', thresholds: [{ color: C.green, value: null }, { color: C.amber, value: 1 }, { color: C.red, value: 2 }], w: 4 }),
  stat('Certified', `max(mq_cert_run_timestamp_seconds{${CERT}}) * 1000`, { desc: 'When the last certification run finished.', unit: 'dateTimeFromNow', mode: 'none', spark: false, w: 4 }),
  stat('MTTD p50', `max(mq_cert_mttd_quantile_seconds{${CERT}, quantile="0.5"})`, { desc: `Median time from fault injection to the alert webhook, across every expected alert of the chaos suite. Baseline p50 ${fmtS(BASE.mttdP50)} (pack spec.baselines).`, unit: 'suffix: s', decimals: 1, spark: false, thresholds: okAbove(BASE.mttdP50, BASE.mttdP95), w: 4 }),
  stat('MTTD p95', `max(mq_cert_mttd_quantile_seconds{${CERT}, quantile="0.95"})`, { desc: `95th percentile time to detect. Baseline p95 ${fmtS(BASE.mttdP95)}.`, unit: 'suffix: s', decimals: 1, spark: false, thresholds: okAbove(BASE.mttdP95, BASE.mttdP95 * 2), w: 4 }),
  stat('MTTR p50 · resolution', `max(mq_cert_mttr_quantile_seconds{${CERT}, quantile="0.5"})`, { desc: `Median time from the recovery action to the resolved webhook: the observability system's share of MTTR (it excludes the human/automation fix time). Baseline MTTR p50 ${fmtS(BASE.mttrP50)}.`, unit: 'suffix: s', decimals: 1, spark: false, thresholds: okAbove(BASE.mttrP50, BASE.mttrP95), w: 4 }),
  stat('MTTR p95 · resolution', `max(mq_cert_mttr_quantile_seconds{${CERT}, quantile="0.95"})`, { desc: `95th percentile resolution after recovery. Baseline MTTR p95 ${fmtS(BASE.mttrP95)}.`, unit: 'suffix: s', decimals: 1, spark: false, thresholds: okAbove(BASE.mttrP95, BASE.mttrP95 * 2), w: 4 }),
];
const chaosExperiments = pack.spec.validation?.chaos_experiments || [];
const mttdBars = (w = 12, h = 8) => bargauge('MTTD per expected alert · against its budget', `mq_cert_mttd_seconds{${CERT}}`, {
  legend: '{{experiment}} · {{alertname}}', unit: 'suffix: s', decimals: 1, min: 0, max: Math.max(...chaosExperiments.map(e => secondsOf(e.expected_mttd || '60s'))) * 1.2, w, h,
  desc: 'Time from injection to the firing webhook for each expected alert in the last run; amber from 75 % of the experiment\'s expected_mttd, red at the budget.',
  overrides: chaosExperiments.flatMap(e => (e.expected_alerts || []).map(a => { const t = secondsOf(e.expected_mttd || '60s'); return byName(`${e.id} · ${a}`, { thresholds: { mode: 'absolute', steps: okAbove(t * 0.75, t) } }); })),
});
const mttrBars = (w = 12, h = 8) => bargauge('Resolution after recovery · per alert', `mq_cert_mttr_seconds{${CERT}}`, {
  legend: '{{experiment}} · {{alertname}}', unit: 'suffix: s', decimals: 1, min: 0, max: 120, w, h, thresholds: okAbove(60, 120),
  desc: 'Time from the recovery action to the resolved webhook in the last run (Prometheus resolve + Alertmanager group_interval + webhook).',
});
const certCounts = () => [
  stat('Conformance passed', `sum(mq_cert_checks{${CERT}, suite="conformance", status="PASS"})`, { desc: 'C1-C10: does the stack implement the pack?', decimals: 0, mode: 'none', spark: false, w: 4 }),
  stat('Synthetic passed', `sum(mq_cert_checks{${CERT}, suite="synthetic", status="PASS"})`, { desc: 'S1-S6: canary, orders flow, no symptom or fast-window burn alert firing.', decimals: 0, mode: 'none', spark: false, w: 4 }),
  stat('Chaos passed', `sum(mq_cert_checks{${CERT}, suite="chaos", status="PASS"})`, { desc: 'Experiments whose alerts fired within budget, resolved after recovery, and whose hypothesis SLI moved as declared.', decimals: 0, mode: 'none', spark: false, w: 4 }),
  stat('Checks failed', `sum(mq_cert_checks{${CERT}, status=~"FAIL|ERROR"}) or vector(0)`, { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 4 }),
  stat('Run duration', `max(mq_cert_run_duration_seconds{${CERT}})`, { unit: 's', decimals: 0, mode: 'none', spark: false, w: 4 }),
  stat('Webhooks in the ledger', `max(mq_alert_sink_events{${CERT}})`, { desc: 'Alertmanager webhook events held by the alert-sink (MTTD is measured from their receipt time).', decimals: 0, mode: 'none', spark: false, w: 4 }),
];
const synthetic = () => [
  stat('Canary attempts · 1 h', 'sum(increase(mq_canary_attempts_total[1h]))', { decimals: 0, mode: 'none', spark: false, w: 4 }),
  stat('Canary failures · 1 h', 'sum(increase(mq_canary_attempts_total{result!="ok"}[1h])) or vector(0)', { decimals: 0, spark: false, thresholds: okAbove(1, 5), w: 4 }),
  stat('Canary p50', 'histogram_quantile(0.5, sum by (le)(rate(mq_canary_roundtrip_duration_seconds_bucket{result="ok"}[5m])))', { unit: 's', decimals: 1, mode: 'none', w: 4 }),
  stat('Orders produced · 1 h', 'sum(increase(mq_orders_produced_total[1h]))', { decimals: 0, mode: 'none', spark: false, w: 4 }),
  stat('Orders consumed · 1 h', 'sum(increase(mq_orders_consumed_total[1h]))', { decimals: 0, mode: 'none', spark: false, w: 4 }),
  stat('Order put errors · 1 h', 'sum(increase(mq_orders_put_errors_total[1h])) or vector(0)', { decimals: 0, spark: false, thresholds: okAbove(1, 10), w: 4 }),
  ts('Canary attempts by result', [{ expr: 'sum by (result)(rate(mq_canary_attempts_total[2m]))', legend: '{{result}}' }], { unit: 'ops', h: 6, colors: RESULT_COLORS, stack: true }),
  ts('Canary round-trip · p50 / p99', [
    { expr: 'histogram_quantile(0.5, sum by (le)(rate(mq_canary_roundtrip_duration_seconds_bucket{result="ok"}[5m])))', legend: 'p50' },
    { expr: 'ibmmq:canary_roundtrip:p99_5m', legend: 'p99' },
  ], { unit: 's', h: 6, colors: { p50: C.blue, p99: C.amber }, lines: [{ value: 0.5, color: C.red }] }),
  ts('Orders flow · produced vs consumed', [
    { expr: 'sum(rate(mq_orders_produced_total[2m]))', legend: 'produced/s' },
    { expr: 'sum(rate(mq_orders_consumed_total[2m]))', legend: 'consumed/s' },
    { expr: 'sum(rate(mq_orders_put_errors_total[2m]))', legend: 'put errors/s' },
  ], { unit: 'ops', h: 6, colors: { 'produced/s': C.blue, 'consumed/s': C.green, 'put errors/s': C.red } }),
  ts('APP.ORDERS.REQ · depth and oldest age', [
    { expr: `max(ibmmq_queue_depth{${EXP}, queue="APP.ORDERS.REQ"})`, legend: 'depth' },
    { expr: `max(ibmmq_queue_oldest_message_age{${EXP}, queue="APP.ORDERS.REQ"})`, legend: 'oldest age' },
  ], { h: 6, decimals: 0, colors: { depth: C.blue, 'oldest age': C.amber }, axisRight: [{ name: 'oldest age', unit: 's', min: 0 }] }),
];
// §9 remediation, straight from the pack: which alert triggers which runbook and automation,
// with the declared guardrails (declared for the platform; nothing in the lab enforces them).
function remediationTable() {
  const rows = (pack.spec.remediation || []).map(r => {
    const alert = String(r.trigger).replace(/^alert:/, '');
    const rb = String(r.runbook || '').replace(/^file:\/\//, '');
    const g = r.guardrails || {};
    const guard = [g.max_invocations_per_hour != null ? `≤ ${g.max_invocations_per_hour}/h` : null, g.requires_human_above ? `human above ${g.requires_human_above}` : null, g.cooldown_after_success ? `cooldown ${g.cooldown_after_success}` : null].filter(Boolean).join(' · ');
    return `| \`${alert}\` | [${rb.replace(/^runbooks\//, '')}](${REPO_URL}/${rb}) | \`${String(r.automation || 'manual-only').replace(/^argo-workflow:\/\//, '')}\` | ${guard || '—'} |`;
  });
  return text(`| Trigger | Runbook | Automation (declared) | Guardrails (declared) |\n|---|---|---|---|\n${rows.join('\n')}\n\n<small>Automations and guardrails come from the pack's \`remediation\` section for the platform to implement; in this lab every action is done by hand, as the runbooks say.</small>`, { title: 'Remediation · runbooks and guardrails', h: 7 });
}

// ---------------------------------------------------------------- overview
nextId = 1;
const overview = dashboard('ibmmq-overview', 'IBM MQ — Overview (pack SLIs)', [
  header('Overview', 'The eight pack SLIs at a glance, the last certification\'s MTTD and MTTR, and the signals behind them.', 'ibmmq-overview'),
  ...sliTiles(),
  ...certTiles().slice(0, 5),
  stat('Symptom alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", burn_rate="", kind=""}) or vector(0)', { desc: 'Symptom alerts currently firing (burn-rate and forecast alerts excluded).', decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 4 }),
  stat('Burn 1 h · process up', 'ibmmq:errorbudget:burn_1h{slo="qmgr_process_up_99_9"}', { binds: 'slos.qmgr_process_up_99_9', desc: SLO_LABEL.qmgr_process_up_99_9, decimals: 1, thresholds: burnThresholds('qmgr_process_up_99_9'), w: 4 }),
  stat('Burn 1 h · canary success', 'ibmmq:errorbudget:burn_1h{slo="canary_success_99_9"}', { binds: 'slos.canary_success_99_9', desc: SLO_LABEL.canary_success_99_9, decimals: 1, thresholds: burnThresholds('canary_success_99_9'), w: 4 }),
  stat('Connections', 'max(ibmmq_qmgr_connection_count{job="ibmmq-exporter"})', { desc: 'Open connections to the queue manager (client view).', decimals: 0, mode: 'none', w: 4 }),
  alertTimelines(12, 4)[0],
  ts('Availability · process vs reachability', [
    { expr: 'ibmmq:qmgr_process_up:ratio_5m', legend: 'process up (native :9157)' },
    { expr: 'ibmmq:qmgr_reachability:ratio_5m', legend: 'reachable (client exporter)' },
  ], { binds: 'slis.qmgr_process_up', unit: 'percentunit', min: 0, max: 1, colors: { 'process up (native :9157)': C.green, 'reachable (client exporter)': C.blue }, lines: [{ value: 0.999 }] }),
  ts('Canary round-trip · p50 / p99', [
    { expr: 'histogram_quantile(0.5, sum by (le)(rate(mq_canary_roundtrip_duration_seconds_bucket{result="ok"}[5m])))', legend: 'p50' },
    { expr: 'ibmmq:canary_roundtrip:p99_5m', legend: 'p99' },
  ], { binds: 'slis.canary_roundtrip_p99', unit: 's', colors: { p50: C.blue, p99: C.amber }, lines: [{ value: 0.5, color: C.red }] }),
  ts('Queue depth headroom by queue', [{ expr: 'ibmmq:queue_depth_headroom:ratio', legend: '{{queue}}' }], { binds: 'slis.queue_depth_headroom', unit: 'percentunit', min: 0, max: 1, many: true, lines: [{ value: 0.8 }, { value: 1, color: C.red }] }),
  ts('Oldest message age by queue', [{ expr: 'ibmmq:oldest_message_age:seconds_max', legend: '{{queue}}' }], { binds: 'slis.oldest_message_age', unit: 's', many: true, lines: [{ value: 60 }] }),
  ts('Canary attempts by result', [{ expr: 'sum by (result)(rate(mq_canary_attempts_total[2m]))', legend: '{{result}}' }], { binds: 'slis.canary_success', unit: 'ops', colors: RESULT_COLORS, stack: true }),
  ts('Orders flow · produced vs consumed', [
    { expr: 'sum(rate(mq_orders_produced_total[2m]))', legend: 'produced/s' },
    { expr: 'sum(rate(mq_orders_consumed_total[2m]))', legend: 'consumed/s' },
    { expr: 'sum(rate(mq_orders_put_errors_total[2m]))', legend: 'put errors/s' },
  ], { unit: 'ops', colors: { 'produced/s': C.blue, 'consumed/s': C.green, 'put errors/s': C.red } }),
  ts('Recovery log write latency', [{ expr: 'ibmmq:log_write_latency:seconds', legend: '{{qmgr}}' }], { binds: 'slis.log_write_latency', unit: 's', colors: { '/.*/': C.violet }, lines: [{ value: 0.02 }] }),
  ts('Queue manager · CPU and filesystem', [
    { expr: 'max by (qmgr)(ibmmq_qmgr_user_cpu_time_percentage{job="ibmmq-exporter"})', legend: 'user cpu' },
    { expr: 'max by (qmgr)(ibmmq_qmgr_system_cpu_time_percentage{job="ibmmq-exporter"})', legend: 'system cpu' },
    { expr: 'min by (qmgr)(ibmmq_qmgr_queue_manager_file_system_free_space_percentage{job="ibmmq-exporter"})', legend: 'filesystem free' },
  ], { unit: 'percent', min: 0, max: 100, colors: { 'user cpu': C.blue, 'system cpu': C.violet, 'filesystem free': C.green } }),
  // The stored line is already the human-readable MQ message (the collector parsed the JSON
  // and kept the id as structured metadata), so no `| json` here: it errored on 96 % of lines.
  logs('Queue manager log', '{service_name="ibmmq"} | line_format "{{.mq_message_id}} {{__line__}}"', { desc: 'MQ console log (AMQ message id + text), parsed by the collector.', h: 8 }),
], ['ibmmq', 'pack', 'slo'], { description: 'IBM MQ pack SLIs, the last certification\'s MTTD/MTTR, error-budget burn and the signals behind them.' });

// ---------------------------------------------------------------- queues & channels
nextId = 1;
const queues = dashboard('ibmmq-queues', 'IBM MQ — Queues & Channels', [
  header('Queues & channels', 'Per-queue depth, headroom, age, throughput and handles; channel state and traffic.', 'ibmmq-queues'),
  bargauge('Headroom by queue · depth / MAXDEPTH', 'ibmmq:queue_depth_headroom:ratio', { legend: '{{queue}}', unit: 'percentunit', max: 1, decimals: 1, thresholds: okAbove(0.8, 1), desc: 'Current depth as a fraction of MAXDEPTH per application queue.', w: 8, h: 8 }),
  ts('Depth by queue', [{ expr: 'ibmmq_queue_depth{job="ibmmq-exporter"}', legend: '{{queue}}' }], { binds: 'ref:queries.per_queue_depth', desc: 'Current depth per queue (exporter, 10 s publications).', w: 8, h: 8, many: true }),
  ts('Oldest message age by queue', [{ expr: 'ibmmq_queue_oldest_message_age{job="ibmmq-exporter"}', legend: '{{queue}}' }], { unit: 's', w: 8, h: 8, lines: [{ value: 60 }] }),
  // mq_prometheus publishes MQI counts as PER-INTERVAL DELTAS (one value per 10 s $SYS
  // publication), scraped as gauges (overrideCType: false). Per-second rate =
  // sum_over_time(...[2m]) / 120 — never rate() (docs/catalogue-evidence/ibmmq.md §4).
  ts('Put rate by queue', [{ expr: 'sum by (queue)(sum_over_time(ibmmq_queue_mqput_mqput1_count{job="ibmmq-exporter"}[2m])) / 120', legend: '{{queue}}' }], { binds: 'ref:queries.per_queue_throughput', desc: 'MQPUT + MQPUT1 per second, from the exporter\'s per-interval counts (sum over 2 m ÷ 120 s).', unit: 'ops', many: true }),
  ts('Get rate by queue', [{ expr: 'sum by (queue)(sum_over_time(ibmmq_queue_mqget_count{job="ibmmq-exporter"}[2m])) / 120', legend: '{{queue}}' }], { desc: 'MQGET per second, same estimator.', unit: 'ops', many: true }),
  ts('Queue time · short / long sample', [
    { expr: 'ibmmq_queue_qtime_short{job="ibmmq-exporter"}', legend: '{{queue}} short' },
    { expr: 'ibmmq_queue_qtime_long{job="ibmmq-exporter"}', legend: '{{queue}} long' },
  ], { desc: 'Time messages spend on the queue (MQ QTIME short and long moving averages).', unit: 'µs', many: true }),
  ts('Open handles · input / output', [
    { expr: 'ibmmq_queue_input_handles{job="ibmmq-exporter"}', legend: '{{queue}} in' },
    { expr: 'ibmmq_queue_output_handles{job="ibmmq-exporter"}', legend: '{{queue}} out' },
  ], { desc: 'Applications with the queue open for input (getters) and output (putters).', many: true, step: true }),
  timeline('Channel status', [{ expr: 'max by (channel, type)(ibmmq_channel_status_squash{job="ibmmq-exporter"})', legend: '{{channel}} ({{type}})' }], { binds: 'ref:queries.per_channel_status', desc: 'Squashed channel status: RUNNING, TRANSITION (binding, starting, retrying, stopping) or INACTIVE / STOPPED.', mappings: STATE_CHANNEL, h: 6 }),
  ts('Channel instances', [{ expr: 'max by (channel)(ibmmq_channel_cur_inst{job="ibmmq-exporter"})', legend: '{{channel}}' }], { desc: 'Current instances per channel (one per client conversation for SVRCONN).', step: true, h: 6, decimals: 0 }),
  ts('Channel messages / s', [{ expr: 'sum by (channel)(sum_over_time(ibmmq_channel_messages{job="ibmmq-exporter"}[2m])) / 120', legend: '{{channel}}' }], { desc: 'Per-interval channel counts (DIS CHSTATUS MSGS deltas), sum over 2 m ÷ 120 s.', unit: 'ops', h: 6 }),
  // Native endpoint names verified live against MQ 10.0.0.5: counters carry a _total suffix
  // and gets are reported as destructive_get (docs/catalogue-evidence/ibmmq.md §4b).
  ts('Queue manager MQI · commits, puts, gets', [
    { expr: 'rate(ibmmq_qmgr_commit_total{job="ibmmq-native"}[2m])', legend: 'commits/s' },
    { expr: 'rate(ibmmq_qmgr_mqput_mqput1_total{job="ibmmq-native"}[2m])', legend: 'mqput/s' },
    { expr: 'rate(ibmmq_qmgr_destructive_get_total{job="ibmmq-native"}[2m])', legend: 'destructive get/s' },
  ], { desc: 'Queue-manager-level MQI rates from the native endpoint (true counters, rate() is right here).', unit: 'ops', h: 6, colors: { 'commits/s': C.violet, 'mqput/s': C.blue, 'destructive get/s': C.green } }),
], ['ibmmq', 'pack'], { description: 'IBM MQ queues and channels in detail.' });

// ---------------------------------------------------------------- slo burn
nextId = 1;
const sloBurn = dashboard('ibmmq-slo-burn', 'IBM MQ — SLO burn rates', [
  header('SLO burn rates', 'Error-budget burn per SLO on the fast and slow windows, and the burn-rate / forecast alert history.', 'ibmmq-slo-burn'),
  ...pack.spec.slos.map(s => stat(`${SLO_RENAME[s.id]} · burn 1 h`, `ibmmq:errorbudget:burn_1h{slo="${s.id}"}`, { binds: `slos.${s.id}`, desc: `1 h burn rate of ${SLO_LABEL[s.id]} (objective ${s.objective} over ${s.window}).`, decimals: 1, thresholds: burnThresholds(s.id), w: 3 })),
  burnBars(null),
  alertTimelines(12, 8)[1],
  ...burnCurves(12),
  ts('Error ratio · 5 m, per SLI', [{ expr: '{__name__=~"ibmmq:.*:error_ratio_5m"}', legend: '{{__name__}}' }], { desc: 'Bad samples over expected samples in the last 5 minutes, per SLI.', unit: 'percentunit', many: true, rename: Object.fromEntries(pack.spec.slis.map(s => [`ibmmq:${s.id}:error_ratio_5m`, s.id])) }),
  stat('Burn-rate alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", burn_rate!=""}) or vector(0)', { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 6, h: 7 }),
  stat('Forecast alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", kind="forecast"}) or vector(0)', { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 6, h: 7 }),
], ['ibmmq', 'pack', 'slo'], { description: 'Multi-window burn rates and forecasts for every IBM MQ pack SLO.' });

// ---------------------------------------------------------------- unified (pack order)
nextId = 1;
const LOGSVC = 'service_name=~"${service:regex}"';
const unified = dashboard('ibmmq-unified', 'IBM MQ — Unified Observability', [
  header('Unified Observability', 'One board in the pack\'s own order: SLIs and SLOs, the validation that proves them (MTTD, MTTR, certification), policy and alerting, remediation, the signals underneath, the pipeline, logs and traces.', 'ibmmq-unified'),

  row('§1-2 · Contract — SLIs and SLOs'),
  ...sliTiles(),
  burnBars(pack.spec.slos.map(s => `slos.${s.id}`), 12, 8),
  ...burnCurves(6, 'hidden'),

  row('§10 · Validation — MTTD, MTTR and certification'),
  ...certTiles(),
  mttdBars(12, 8),
  mttrBars(12, 8),
  ...certCounts(),

  row('§10 · Validation — synthetic canary and orders flow'),
  ...synthetic(),

  row('§7-8 · Policy and alerting'),
  stat('Symptom alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", burn_rate="", kind=""}) or vector(0)', { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 4 }),
  stat('Burn-rate alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", burn_rate!=""}) or vector(0)', { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 4 }),
  stat('Forecast alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", kind="forecast"}) or vector(0)', { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 4 }),
  alertTimelines(12, 4)[0],
  alertTable(12, 8),
  alertTimelines(12, 8)[1],

  row('§9 · Remediation — runbooks and guardrails'),
  remediationTable(),

  row('Signals — queue manager availability'),
  stat('Queue manager', `max(ibmmq_qmgr_status{${EXP}})`, { desc: 'Status as seen by an MQ client over DEV.ADMIN.SVRCONN.', mappings: STATE_QMGR, mode: 'solid', thresholds: [{ color: C.red, value: null }, { color: C.green, value: 2 }], w: 4 }),
  stat('Native endpoint', `max(up{${NAT}})`, { desc: 'Scrape of the queue manager\'s own :9157 endpoint (process alive).', mappings: STATE_UPDOWN, mode: 'solid', thresholds: okBelow(1, 1), w: 4 }),
  stat('Exporter scrape', `max(up{${EXP}})`, { desc: 'Scrape of mq_prometheus (queue/channel detail; dies with the listener).', mappings: STATE_UPDOWN, mode: 'solid', thresholds: okBelow(1, 1), w: 4 }),
  stat('Active listeners', `max(ibmmq_qmgr_active_listeners{${EXP}})`, { decimals: 0, spark: false, thresholds: okBelow(1, 1), w: 4 }),
  stat('Connections', `max(ibmmq_qmgr_connection_count{${EXP}})`, { decimals: 0, mode: 'none', w: 4 }),
  stat('Uptime', `max(ibmmq_qmgr_uptime{${EXP}})`, { unit: 's', decimals: 1, mode: 'none', spark: false, w: 4 }),
  timeline('Availability timeline', [
    { expr: `max(up{${NAT}})`, legend: 'process (native endpoint)' },
    { expr: `max(ibmmq_qmgr_status{${EXP}})`, legend: 'client view (exporter)' },
    { expr: `max(ibmmq_qmgr_command_server_status{${EXP}})`, legend: 'command server' },
    { expr: `max(ibmmq_qmgr_channel_initiator_status{${EXP}})`, legend: 'channel initiator' },
  ], { desc: 'Process alive vs reachable by clients, plus the command server and channel initiator. The differential diagnosis, over time.', mappings: STATE_QMGR, h: 7,
    overrides: [byName('process (native endpoint)', { mappings: STATE_UPDOWN }), byName('command server', { mappings: STATE_SERVICE }), byName('channel initiator', { mappings: STATE_SERVICE })] }),
  ts('Availability ratios · 5 m', [
    { expr: 'ibmmq:qmgr_process_up:ratio_5m', legend: 'process up' },
    { expr: 'ibmmq:qmgr_reachability:ratio_5m', legend: 'reachable' },
  ], { unit: 'percentunit', min: 0, max: 1, h: 7, colors: { 'process up': C.green, reachable: C.blue }, lines: [{ value: 0.999 }] }),

  row('Signals — queues'),
  bargauge('Headroom by queue · depth / MAXDEPTH', `ibmmq:queue_depth_headroom:ratio{${Q}}`, { legend: '{{queue}}', unit: 'percentunit', max: 1, decimals: 1, thresholds: okAbove(0.8, 1), desc: 'Current depth as a fraction of MAXDEPTH per application queue.', w: 8, h: 8 }),
  ts('Depth by queue', [{ expr: `max by (queue)(ibmmq_queue_depth{${EXP}, ${Q}})`, legend: '{{queue}}' }], { w: 8, h: 8, many: true }),
  ts('Oldest message age by queue', [{ expr: `ibmmq:oldest_message_age:seconds_max{${Q}}`, legend: '{{queue}}' }], { unit: 's', w: 8, h: 8, lines: [{ value: 60 }] }),
  ts('Put / get rate by queue', [
    { expr: `sum by (queue)(sum_over_time(ibmmq_queue_mqput_mqput1_count{${EXP}, ${Q}}[2m])) / 120`, legend: '{{queue}} put/s' },
    { expr: `sum by (queue)(sum_over_time(ibmmq_queue_mqget_count{${EXP}, ${Q}}[2m])) / 120`, legend: '{{queue}} get/s' },
  ], { desc: 'MQI counts are per-interval deltas from the exporter: sum over 2 m ÷ 120 s.', unit: 'ops', many: true }),
  table('Queue snapshot', [
    { expr: `max by (queue)(ibmmq_queue_depth{${EXP}, ${Q}})`, instant: true, format: 'table' },
    { expr: `max by (queue)(ibmmq_queue_attribute_max_depth{${EXP}, ${Q}})`, instant: true, format: 'table' },
    { expr: `max by (queue)(ibmmq_queue_oldest_message_age{${EXP}, ${Q}})`, instant: true, format: 'table' },
    { expr: `max by (queue)(ibmmq_queue_input_handles{${EXP}, ${Q}})`, instant: true, format: 'table' },
    { expr: `max by (queue)(ibmmq_queue_output_handles{${EXP}, ${Q}})`, instant: true, format: 'table' },
  ], { desc: 'Depth, MAXDEPTH, oldest message age and open handles per queue, right now.', h: 7, transformations: [
    { id: 'merge', options: {} },
    { id: 'organize', options: { excludeByName: { Time: true }, renameByName: { queue: 'queue', 'Value #A': 'depth', 'Value #B': 'MAXDEPTH', 'Value #C': 'oldest age (s)', 'Value #D': 'input handles', 'Value #E': 'output handles' } } },
  ], overrides: [byName('oldest age (s)', { 'custom.cellOptions': { type: 'color-background', mode: 'gradient' }, thresholds: { mode: 'absolute', steps: okAbove(60, 120) } }), byName('depth', { 'custom.cellOptions': { type: 'gauge', mode: 'gradient' }, thresholds: { mode: 'absolute', steps: okAbove(80, 160) }, min: 0, max: 200 })] }),
  ts('Open handles by queue · in / out', [
    { expr: `max by (queue)(ibmmq_queue_input_handles{${EXP}, ${Q}})`, legend: '{{queue}} in' },
    { expr: `max by (queue)(ibmmq_queue_output_handles{${EXP}, ${Q}})`, legend: '{{queue}} out' },
  ], { w: 8, h: 6, step: true, decimals: 0 }),
  ts('Queue time · short / long sample', [
    { expr: `max by (queue)(ibmmq_queue_qtime_short{${EXP}, ${Q}})`, legend: '{{queue}} short' },
    { expr: `max by (queue)(ibmmq_queue_qtime_long{${EXP}, ${Q}})`, legend: '{{queue}} long' },
  ], { unit: 'µs', w: 8, h: 6 }),
  ts('Uncommitted messages · expired per 2 m', [
    { expr: `max by (queue)(ibmmq_queue_uncommitted_messages{${EXP}, ${Q}})`, legend: '{{queue}} uncommitted' },
    { expr: `sum by (queue)(sum_over_time(ibmmq_queue_expired_messages{${EXP}, ${Q}}[2m]))`, legend: '{{queue}} expired/2m' },
  ], { w: 8, h: 6, decimals: 0 }),

  row('Signals — channels and connections'),
  timeline('Channel status', [{ expr: `max by (channel, type)(ibmmq_channel_status_squash{${EXP}})`, legend: '{{channel}} ({{type}})' }], { desc: 'Squashed channel status per channel.', mappings: STATE_CHANNEL, h: 6 }),
  ts('Channel instances', [{ expr: `max by (channel)(ibmmq_channel_cur_inst{${EXP}})`, legend: '{{channel}}' }], { desc: 'One instance per client conversation on a SVRCONN channel.', step: true, decimals: 0, h: 6 }),
  ts('Channel messages / s', [{ expr: `sum by (channel)(sum_over_time(ibmmq_channel_messages{${EXP}}[2m])) / 120`, legend: '{{channel}}' }], { desc: 'Per-interval channel message counts, sum over 2 m ÷ 120 s.', unit: 'ops', h: 6 }),
  ts('Channel bytes / s · sent and received', [
    { expr: `sum by (channel)(sum_over_time(ibmmq_channel_bytes_sent{${EXP}}[2m])) / 120`, legend: '{{channel}} sent' },
    { expr: `sum by (channel)(sum_over_time(ibmmq_channel_bytes_rcvd{${EXP}}[2m])) / 120`, legend: '{{channel}} rcvd' },
  ], { unit: 'Bps', h: 6, colors: { '/ sent$/': C.blue, '/ rcvd$/': C.green } }),

  row('Signals — queue manager resources'),
  gauge('User CPU', `max(ibmmq_qmgr_user_cpu_time_percentage{${NAT}})`, { thresholds: okAbove(70, 90) }),
  gauge('RAM free', `max(ibmmq_qmgr_ram_free_percentage{${NAT}})`, { thresholds: okBelow(20, 10) }),
  gauge('Queue manager filesystem free', `max(ibmmq_qmgr_queue_manager_file_system_free_space_percentage{${NAT}})`, { thresholds: okBelow(25, 15) }),
  gauge('Log filesystem free', `max(ibmmq_qmgr_log_file_system_free_space_percentage{${NAT}})`, { thresholds: okBelow(25, 15) }),
  gauge('Log primary space in use', `max(ibmmq_qmgr_log_primary_space_in_use_percentage{${NAT}})`, { thresholds: okAbove(70, 90) }),
  stat('Log write latency', `max(ibmmq_qmgr_log_write_latency_seconds{${NAT}})`, { unit: 's', decimals: 1, thresholds: okAbove(0.02, 0.05), w: 4, h: 5 }),
  ts('CPU · user / system', [
    { expr: `max(ibmmq_qmgr_user_cpu_time_percentage{${NAT}})`, legend: 'user' },
    { expr: `max(ibmmq_qmgr_system_cpu_time_percentage{${NAT}})`, legend: 'system' },
  ], { unit: 'percent', min: 0, h: 6, colors: { user: C.blue, system: C.violet }, stack: true }),
  ts('MQI calls / s', [
    { expr: `sum(rate(ibmmq_qmgr_mqput_mqput1_total{${NAT}}[2m]))`, legend: 'mqput' },
    { expr: `sum(rate(ibmmq_qmgr_destructive_get_total{${NAT}}[2m]))`, legend: 'destructive get' },
    { expr: `sum(rate(ibmmq_qmgr_commit_total{${NAT}}[2m]))`, legend: 'commit' },
    { expr: `sum(rate(ibmmq_qmgr_rollback_total{${NAT}}[2m]))`, legend: 'rollback' },
    { expr: `sum(rate(ibmmq_qmgr_mqconn_mqconnx_total{${NAT}}[2m]))`, legend: 'connect' },
  ], { unit: 'ops', h: 6, colors: { mqput: C.blue, 'destructive get': C.green, commit: C.violet, rollback: C.red, connect: C.cyan } }),
  ts('Failed MQI calls / s · expired messages', [
    { expr: `sum(rate(ibmmq_qmgr_failed_mqput_total{${NAT}}[2m]))`, legend: 'failed mqput' },
    { expr: `sum(rate(ibmmq_qmgr_failed_mqget_total{${NAT}}[2m]))`, legend: 'failed mqget' },
    { expr: `sum(rate(ibmmq_qmgr_failed_mqopen_total{${NAT}}[2m]))`, legend: 'failed mqopen' },
    { expr: `sum(rate(ibmmq_qmgr_failed_mqconn_mqconnx_total{${NAT}}[2m]))`, legend: 'failed connect' },
    { expr: `sum(rate(ibmmq_qmgr_expired_message_total{${NAT}}[2m]))`, legend: 'expired' },
  ], { unit: 'ops', h: 6, colors: { 'failed mqput': C.red, 'failed mqget': C.amber, 'failed mqopen': C.pink, 'failed connect': C.violet, expired: C.slate } }),
  ts('Puts / s · persistent vs non-persistent', [
    { expr: `sum(rate(ibmmq_qmgr_persistent_message_mqput_total{${NAT}}[2m]) + rate(ibmmq_qmgr_persistent_message_mqput1_total{${NAT}}[2m]))`, legend: 'persistent' },
    { expr: `sum(rate(ibmmq_qmgr_non_persistent_message_mqput_total{${NAT}}[2m]) + rate(ibmmq_qmgr_non_persistent_message_mqput1_total{${NAT}}[2m]))`, legend: 'non-persistent' },
  ], { unit: 'ops', h: 6, colors: { persistent: C.violet, 'non-persistent': C.cyan }, stack: true }),
  ts('Recovery log written / s · logical vs physical', [
    { expr: `sum(rate(ibmmq_qmgr_log_logical_written_bytes_total{${NAT}}[2m]))`, legend: 'logical' },
    { expr: `sum(rate(ibmmq_qmgr_log_physical_written_bytes_total{${NAT}}[2m]))`, legend: 'physical' },
  ], { unit: 'Bps', h: 6, colors: { logical: C.blue, physical: C.violet } }),
  ts('Recovery log · write latency and space in use', [
    { expr: `max(ibmmq_qmgr_log_write_latency_seconds{${NAT}})`, legend: 'write latency' },
    { expr: `max(ibmmq_qmgr_log_in_use_bytes{${NAT}}) / max(ibmmq_qmgr_log_max_bytes{${NAT}})`, legend: 'in use / max' },
  ], { unit: 's', decimals: 1, h: 6, colors: { 'write latency': C.amber, 'in use / max': C.blue }, axisRight: [{ name: 'in use / max', unit: 'percentunit', min: 0, max: 1 }] }),

  row('§3-5 · Pipelines, storage and queries'),
  stat('TSDB series', 'max(prometheus_tsdb_head_series)', { desc: 'Active series in Prometheus (2 d retention in the lab).', decimals: 0, mode: 'none', w: 4, h: 5 }),
  stat('Samples appended / s', 'sum(rate(prometheus_tsdb_head_samples_appended_total[2m]))', { unit: 'ops', decimals: 0, mode: 'none', w: 4, h: 5 }),
  stat('Recording rules producing', 'count(count by (__name__)({__name__=~"ibmmq:.*"}))', { desc: 'Distinct ibmmq:* recording-rule series currently produced (pack queries + generated error-budget rules).', decimals: 0, mode: 'none', spark: false, w: 4, h: 5 }),
  ts('Scrape duration by MQ job', [{ expr: 'max by (job)(scrape_duration_seconds{job=~"ibmmq-.*|certification"})', legend: '{{job}}' }], { unit: 's', w: 12, h: 5, colors: { 'ibmmq-native': C.green, 'ibmmq-exporter': C.blue, certification: C.slate } }),
  ts('Collector · exported per second', [
    { expr: 'sum by (exporter)(rate(otelcol_exporter_sent_metric_points_total[2m]))', legend: 'metric points → {{exporter}}' },
    { expr: 'sum by (exporter)(rate(otelcol_exporter_sent_log_records_total[2m]))', legend: 'log records → {{exporter}}' },
    { expr: 'sum by (exporter)(rate(otelcol_exporter_sent_spans_total[2m]))', legend: 'spans → {{exporter}}' },
  ], { unit: 'ops', h: 6, colors: { '/^metric points/': C.blue, '/^log records/': C.green, '/^spans/': C.violet } }),
  ts('Collector · export failures per second', [
    { expr: 'sum by (exporter)(rate(otelcol_exporter_send_failed_metric_points_total[2m])) or vector(0)', legend: 'metric points {{exporter}}' },
    { expr: 'sum by (exporter)(rate(otelcol_exporter_send_failed_log_records_total[2m])) or vector(0)', legend: 'log records {{exporter}}' },
    { expr: 'sum by (exporter)(rate(otelcol_exporter_send_failed_spans_total[2m])) or vector(0)', legend: 'spans {{exporter}}' },
  ], { desc: 'The failure counters only exist once a batch has failed; a flat zero is the collector saying nothing has.', unit: 'ops', h: 6, colors: { '/.*/': C.red } }),

  row('Logs and traces'),
  logs('Logs · queue manager and apps', `{${LOGSVC}}`, { desc: 'Filter with the "Log service" variable. App lines carry trace_id / span_id; click a line to jump to its trace.', h: 10 }),
  traces('Recent traces · producer → consumer through MQ', '{ resource.service.name =~ "mq-canary|orders-producer|orders-consumer" }', { desc: 'Open a consumer "receive" span: its link points at the producer trace whose context travelled in the message properties.', h: 8 }),
], ['ibmmq', 'pack', 'unified'], {
  description: 'Everything about the IBM MQ lab on one board, in the pack\'s order: SLIs and SLOs, MTTD/MTTR and certification, policy and alerting, remediation, signals, pipeline, logs and traces.',
  time: { from: 'now-3h', to: 'now' },
  templating: { list: [
    { name: 'queue', label: 'Queue', type: 'query', datasource: DS, refresh: 2, sort: 1, multi: true, includeAll: true, allValue: '.*',
      query: { query: 'label_values(ibmmq_queue_depth{job="ibmmq-exporter"}, queue)', refId: 'StandardVariableQuery' },
      definition: 'label_values(ibmmq_queue_depth{job="ibmmq-exporter"}, queue)', current: { text: 'All', value: '$__all', selected: true }, options: [] },
    // Options come from Loki (every service the collector names); "All" means the four MQ services.
    { name: 'service', label: 'Log service', type: 'query', datasource: LOKI, refresh: 2, sort: 1, multi: true, includeAll: true,
      allValue: 'ibmmq|mq-canary|orders-producer|orders-consumer',
      query: { label: 'service_name', refId: 'LokiVariableQueryEditor-VariableQuery', stream: '', type: 1 },
      definition: 'label_values(service_name)', current: { text: 'All', value: '$__all', selected: true }, options: [] },
  ] },
});

writeFileSync('stack/grafana/dashboards/ibmmq-overview.json', JSON.stringify(overview, null, 2) + '\n');
writeFileSync('stack/grafana/dashboards/ibmmq-queues.json', JSON.stringify(queues, null, 2) + '\n');
writeFileSync('stack/grafana/dashboards/ibmmq-slo-burn.json', JSON.stringify(sloBurn, null, 2) + '\n');
writeFileSync('stack/grafana/dashboards/ibmmq-unified.json', JSON.stringify(unified, null, 2) + '\n');
console.log('dashboards written');
