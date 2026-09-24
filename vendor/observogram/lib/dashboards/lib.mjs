// Shared dashboard library: the visual system (palette, thresholds, state mappings), the panel
// factories, the flow layout, the dashboard envelope, and the building blocks that are derived
// from any ObservabilityPack (SLI tiles, error-budget burn, alert timelines, certification,
// remediation). Pack-specific rows live in tools/dashboards/packs/<name>.mjs; the driver is
// tools/gen-dashboards.mjs. Nothing here reads a pack at import time: `configure(ctx)` binds the
// pack context (name, version, boards, labels) before any panel is built.
//
// Visual system (shared by every board):
//   * one calm palette (C) for series, thresholds and state colours; thresholds colour the
//     VALUE of a stat, not a wall of green tiles; status tiles are the only solid ones;
//   * stats carry a sparkline of the same series; gauges for bounded resources; bar gauges for
//     "how close to the limit" views (headroom, burn per SLO, MTTD per alert vs target);
//   * state timelines for anything that is a state over time (with color.mode fixed: with
//     thresholds Grafana 12 ignores value-mapping colours and renders grey rows, measured);
//   * time series: smooth lines, soft gradient fill, nulls bridged across exporter gaps,
//     dashed SLO threshold lines, table legends with last/max where there are many series;
//   * a header banner with cross-board navigation; rows without emoji; annotations only for
//     symptom alerts (burn alerts painted every graph red for an hour after each incident).
// Layout is computed by flow(): add panels in reading order, never by coordinates. Every visual
// row is 24 columns wide and every panel on it has the same height, so nothing wraps alone and
// no hole sits under a short tile: a run of n tiles takes tileRows(n) — rows of at most eight,
// each splitWidths(count) (floor plus the remainder on the first tiles: 5 → 5,5,5,5,4;
// 7 → 4,4,4,3,3,3,3; 9 → 5,5,5,5,4 over 6,6,6,6), so no tile is narrower than w3; a lone tile is
// not stretched to the row but sits w6 h8 beside its trend (derivedSliTrend) or, on a burn board,
// beside the alert timeline; derived views take viewWidths(n) (1 → 24; 2 → 12,12; 3 → 8,8,8;
// more → pairs of 12, closing with a trio of 8 when odd — a view on a trio row is w8, below the
// width at which ts() switches to a table legend, so it gets the bottom list legend); and a
// source board's contract block is shaped by how many SLIs and SLOs it binds (generic.mjs
// contractBlock). A text note (an undeclared or unrenderable view) is always w24 on a row of its own.

import { metricPrefix } from '../burn-rules.mjs';
import { goodWhen, boundText } from '../good-when.mjs';

export const DS = { type: 'prometheus', uid: 'prom' };
export const LOKI = { type: 'loki', uid: 'loki' };
export const TEMPO = { type: 'tempo', uid: 'tempo' };

export const secondsOf = (d) => { const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(String(d).trim()); if (!m) throw new Error(`duration ${d}`); return Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[m[2]]; };
export const fmtS = (s) => (s >= 60 ? `${s / 60} min` : `${s} s`);

// ---------------------------------------------------------------- palette & thresholds
export const C = { blue: '#5B8DEF', green: '#3DD68C', amber: '#F5B14C', red: '#F0616D', violet: '#A78BFA', cyan: '#38BDF8', slate: '#8B98A9', pink: '#F472B6', teal: '#2DD4BF', dim: '#4B5563' };
export const okAbove = (warn, bad) => [{ color: C.green, value: null }, { color: C.amber, value: warn }, { color: C.red, value: bad }];   // higher is worse
export const okBelow = (warn, bad) => [{ color: C.red, value: null }, { color: C.amber, value: bad }, { color: C.green, value: warn }];   // lower is worse
export const neutral = [{ color: C.slate, value: null }];
export const fixed = (color) => ({ mode: 'fixed', fixedColor: color });

export const STATE_UPDOWN = [{ type: 'value', options: { '1': { text: 'UP', color: C.green }, '0': { text: 'DOWN', color: C.red } } }];
export const STATE_ALERT = [{ type: 'value', options: { '2': { text: 'FIRING', color: C.red }, '1': { text: 'PENDING', color: C.amber }, '0': { text: 'quiet', color: '#1E3A34' } } }];
export const STATE_VERDICT = [{ type: 'value', options: { '0': { text: 'PASS', color: C.green }, '1': { text: 'WARN', color: C.amber }, '2': { text: 'FAIL', color: C.red }, '3': { text: 'ERROR', color: C.red } } }];

// ---------------------------------------------------------------- pack context
// Bound once per generator run. `boards` drives the header navigation and the dashboard links;
// `sloLabel` / `sloRename` name SLOs on bar gauges and legends; `certSel` selects the
// certification metrics the alert-sink publishes for this pack.
let CTX = null;
export function configure(ctx) {
  const pack = ctx.pack;
  const slos = pack.spec.slos || [];
  const label = ctx.sloLabel || Object.fromEntries(slos.map(s => [s.id, defaultSloLabel(pack, s)]));
  CTX = {
    // svc is the metric-name prefix the generators emit (`payment-service` → `payment_service`);
    // packName is the raw name used in label values.
    pack, svc: metricPrefix(pack.metadata.name), packName: pack.metadata.name, packVersion: pack.metadata.version,
    displayName: ctx.displayName || humanize(pack.metadata.name),
    repoUrl: ctx.repoUrl, boards: ctx.boards || [],
    sloLabel: label,
    sloRename: Object.fromEntries(Object.entries(label).map(([id, l]) => [id, l.replace(/ · .*$/, '')])),
    certSel: ctx.certSel || `job="certification", pack="${pack.metadata.name}"`,
    base: {
      mttdP50: secondsOf(pack.spec.baselines?.mttd_target_p50 || '2m'), mttdP95: secondsOf(pack.spec.baselines?.mttd_target_p95 || '5m'),
      mttrP50: secondsOf(pack.spec.baselines?.mttr_target_p50 || '30m'), mttrP95: secondsOf(pack.spec.baselines?.mttr_target_p95 || '1h'),
    },
  };
  return CTX;
}
export const ctx = () => { if (!CTX) throw new Error('dashboards/lib: configure(ctx) first'); return CTX; };
export const humanize = (id) => { const s = String(id).replace(/[_-]+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
export const pct = (objective) => `${Number((objective * 100).toFixed(3))} %`;
function defaultSloLabel(pack, slo) {
  const sli = (pack.spec.slis || []).find(s => s.id === slo.sli);
  return `${humanize(sli ? sli.id : slo.id)} · ${pct(slo.objective)}`;
}
// Burn-rate colours come from the SLO's own policy windows (amber at the smallest factor that
// alerts, red at the largest); a fixed 6×/14× stayed green while message_age's 4× alert fired.
export function burnFactors(sloId) {
  const f = (ctx().pack.spec.policy?.burn_rate_alerts || []).filter(b => b.slo === sloId).flatMap(b => (b.windows || []).map(w => Number(w.factor))).filter(Number.isFinite);
  return f.length ? { warn: Math.min(...f), bad: Math.max(...f) } : { warn: 6, bad: 14 };
}
export const burnThresholds = (sloId) => { const { warn, bad } = burnFactors(sloId); return okAbove(warn, bad); };

// ---------------------------------------------------------------- panel factories
let nextId = 1;
export const resetIds = () => { nextId = 1; };
const refIds = (i) => String.fromCharCode(65 + i);
export function base(type, title, { binds, desc, w = 12, h = 8, datasource = DS } = {}, extra) {
  const bindsArr = binds ? (Array.isArray(binds) ? binds : [binds]) : null;
  return { id: nextId++, type, title, datasource, gridPos: { x: 0, y: 0, w, h }, ...(desc ? { description: desc } : {}), ...(bindsArr ? { pack: { binds_to: bindsArr } } : {}), ...extra };
}
export const props = (o) => Object.entries(o).map(([id, value]) => ({ id, value }));
export const byName = (name, o) => ({ matcher: { id: 'byName', options: name }, properties: props(o) });
export const byRegexp = (re, o) => ({ matcher: { id: 'byRegexp', options: re }, properties: props(o) });
export const colorOverrides = (colors = {}) => Object.entries(colors).map(([n, c]) => (n.startsWith('/') ? byRegexp(n.slice(1, -1), { color: fixed(c) }) : byName(n, { color: fixed(c) })));

/** Single value. mode: 'value' (coloured number + sparkline), 'solid' (status tile), 'none' (informational). */
export function stat(title, expr, { binds, desc, unit = 'none', decimals, thresholds, mappings, mode = 'value', spark = true, w = 4, h = 4 } = {}) {
  const colorMode = mode === 'solid' ? 'background_solid' : mode === 'none' ? 'none' : 'value';
  const range = mode !== 'solid' && spark;
  return base('stat', title, { binds, desc, w, h }, {
    targets: [{ refId: 'A', expr, instant: !range, range, legendFormat: '__auto' }],
    fieldConfig: { defaults: { unit, decimals, mappings: mappings || [], color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: thresholds || neutral } }, overrides: [] },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode, graphMode: range ? 'area' : 'none', textMode: 'value', justifyMode: 'center', wideLayout: true, orientation: 'auto', showPercentChange: false },
  });
}
/** Radial gauge for a bounded quantity (0-100 % resources). */
export function gauge(title, expr, { desc, unit = 'percent', min = 0, max = 100, decimals = 0, thresholds, w = 4, h = 5 } = {}) {
  return base('gauge', title, { desc, w, h }, {
    targets: [{ refId: 'A', expr, instant: true }],
    fieldConfig: { defaults: { unit, min, max, decimals, color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: thresholds || neutral } }, overrides: [] },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, orientation: 'auto', showThresholdLabels: false, showThresholdMarkers: true, sizing: 'auto', minVizWidth: 75, minVizHeight: 75 },
  });
}
/** Horizontal bars, one per series: how close each item is to its limit. */
export function bargauge(title, expr, { binds, desc, legend = '__auto', unit = 'none', min = 0, max, decimals, thresholds, overrides = [], w = 12, h = 8, text } = {}) {
  return base('bargauge', title, { binds, desc, w, h }, {
    targets: [{ refId: 'A', expr, instant: true, legendFormat: legend }],
    fieldConfig: { defaults: { unit, min, max, decimals, color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: thresholds || neutral } }, overrides },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, orientation: 'horizontal', displayMode: 'gradient', valueMode: 'color', namePlacement: 'left', showUnfilled: true, sizing: 'auto', minVizWidth: 8, minVizHeight: 14, maxVizHeight: 26, legend: { showLegend: false }, ...(text ? { text } : {}) },
  });
}
/**
 * Time series. legend: 'list' | 'table' | 'hidden' | 'auto' (table with last/max when ≥ 12 wide
 * and `many` series are expected). `lines` draws dashed threshold lines. `colors` maps
 * series display names (or "/regex/") to fixed colours. `rename` maps display names.
 */
export function ts(title, targets, { binds, desc, unit = 'none', decimals, min, max, w = 12, h = 7, legend = 'auto', many = false, lines, colors, rename, step = false, stack = false, axisRight = [], fill = 10, softMin = 0 } = {}) {
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
/** State over time (status codes, alert pending/firing). `mappings` colour and label the states. */
export function timeline(title, targets, { binds, desc, mappings, overrides = [], w = 12, h = 6, legend = true } = {}) {
  return base('state-timeline', title, { binds, desc, w, h }, {
    targets: targets.map((t, i) => ({ refId: refIds(i), expr: t.expr, legendFormat: t.legend || '__auto' })),
    fieldConfig: { defaults: { color: { mode: 'fixed', fixedColor: C.dim }, mappings: mappings || [], custom: { lineWidth: 0, fillOpacity: 78 } }, overrides },
    options: { mergeValues: true, showValue: 'never', alignValue: 'center', rowHeight: 0.82, legend: { showLegend: legend, displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'single', sort: 'none' } },
  });
}
export function table(title, targets, { binds, desc, w = 12, h = 8, datasource = DS, transformations = [], overrides = [], sortBy } = {}) {
  return base('table', title, { binds, desc, w, h, datasource }, {
    targets: targets.map((t, i) => ({ refId: refIds(i), datasource, ...t })),
    transformations,
    fieldConfig: { defaults: { custom: { align: 'auto', cellOptions: { type: 'auto' }, filterable: false } }, overrides },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false, reducer: ['sum'], countRows: false, fields: '' }, ...(sortBy ? { sortBy: [sortBy] } : {}) },
  });
}
export function traces(title, traceql, { desc, w = 24, h = 8, limit = 20 } = {}) {
  return base('table', title, { desc, w, h, datasource: TEMPO }, {
    targets: [{ refId: 'A', datasource: TEMPO, queryType: 'traceql', query: traceql, limit, tableType: 'traces' }],
    options: { showHeader: true, cellHeight: 'sm' },
  });
}
export function logs(title, expr, { desc, w = 24, h = 9 } = {}) {
  return base('logs', title, { desc, w, h, datasource: LOKI }, {
    targets: [{ refId: 'A', expr }],
    options: { showTime: true, showLabels: false, showCommonLabels: false, wrapLogMessage: true, prettifyLogMessage: false, enableLogDetails: true, dedupStrategy: 'none', sortOrder: 'Descending' },
  });
}
export function row(title) { return base('row', title, { w: 24, h: 1, datasource: undefined }, { collapsed: false, panels: [] }); }
export function text(content, { title = '', w = 24, h = 4, transparent = false } = {}) {
  return base('text', title, { w, h, datasource: undefined }, { transparent, options: { mode: 'markdown', content, code: { language: 'plaintext', showLineNumbers: false, showMiniMap: false } } });
}
/** Header banner: what the board is, pack version, and the other boards. */
export function header(name, blurb, uid) {
  const c = ctx();
  const nav = c.boards.map(([u, t]) => (u === uid ? `**${t}**` : `[${t}](/d/${u}?${'$'}{__url_time_range})`)).join(' · ');
  return text(`### ${c.displayName} · ${name}\n${blurb} &nbsp;·&nbsp; pack \`${c.packName}@${c.packVersion}\` &nbsp;·&nbsp; ${nav}`, { h: 2, transparent: true });
}

// ---------------------------------------------------------------- layout & envelope
/**
 * n widths that sum to `total` and differ by at most one: the floor, with the remainder spread
 * over the first tiles (5 → 5,5,5,5,4; 7 → 4,4,4,3,3,3,3; 6 → 4×6; 8 → 3×8; 1 → 24). n ≤ 0 gives
 * [] and n > total gives n ones (Grafana's narrowest column), never a zero-width panel.
 */
export const splitWidths = (n, total = 24) => {
  if (!(n > 0)) return [];
  if (n > total) return Array(n).fill(1);
  const floor = Math.floor(total / n), rem = total % n;
  return Array.from({ length: n }, (_, i) => floor + (i < rem ? 1 : 0));
};
/**
 * n tiles in rows of at most `perRow` (default eight, so no tile is narrower than w3): the
 * fewest rows, with counts that differ by at most one and the larger rows first, each row
 * splitWidths(count). 9 → [5,5,5,5,4], [6,6,6,6]; 12 → two rows of 4×6; 13 → 7 + 6; 25 →
 * 7 + 6 + 6 + 6. Returns the rows; `.flat()` is the per-tile width list flow() lays out.
 */
export const tileRows = (n, perRow = 8) => {
  if (!(n > 0)) return [];
  const rows = Math.ceil(n / perRow), floor = Math.floor(n / rows), rem = n % rows;
  return Array.from({ length: rows }, (_, i) => splitWidths(floor + (i < rem ? 1 : 0)));
};
/**
 * Widths for n derived-view time series: one takes the row, two share it, three make a trio;
 * from four on they come in pairs of 12, and an odd count closes with a trio of 8 so the last
 * row is as full as the others (5 → 12,12,8,8,8).
 */
export const viewWidths = (n) => {
  if (!(n > 0)) return [];
  if (n <= 3) return splitWidths(n);
  return n % 2 === 0 ? Array(n).fill(12) : [...Array(n - 3).fill(12), 8, 8, 8];
};
// Flow layout: left-to-right in 24-column lines in the order given; a row always starts a line.
export function flow(items, startY = 0) {
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
export function dashboard(uid, title, panels, tags, { templating = { list: [] }, time = { from: 'now-1h', to: 'now' }, description } = {}) {
  const c = ctx();
  const links = c.boards.filter(([u]) => u !== uid).map(([u, t]) => ({ title: t, type: 'link', url: `/d/${u}`, icon: 'dashboard', keepTime: true, includeVars: false, targetBlank: false, asDropdown: false, tags: [] }));
  return {
    uid, title, description, tags, timezone: 'browser', schemaVersion: 41, version: 1, editable: true, graphTooltip: 1, liveNow: false, refresh: '30s',
    fiscalYearStartMonth: 0, weekStart: '',
    timepicker: { refresh_intervals: ['10s', '30s', '1m', '5m', '15m'] },
    time, templating,
    annotations: { list: [
      // symptom alerts only: burn-rate alerts keep firing for hours after an incident and painted
      // every graph red; the policy row has its own timeline for them
      { name: 'Symptom alerts', datasource: DS, enable: true, hide: false, iconColor: C.red, expr: `ALERTS{alertstate="firing", pack="${c.packName}", burn_rate="", kind=""}`, step: '10s', titleFormat: '{{alertname}}', textFormat: '{{severity}} · {{qmgr}} {{queue}}' },
    ] },
    links, panels: flow(panels),
  };
}

// ---------------------------------------------------------------- pack-derived blocks
// 2 = firing, 1 = pending per alertname; the trailing "no alert" row is always present at 0
// so a quiet period renders as a calm baseline instead of Grafana's "no time field" notice.
export const alertState = (sel, baseline = true) => { const p = ctx().packName; return `(2 * max by (alertname) (ALERTS{pack="${p}", alertstate="firing", ${sel}})) or max by (alertname) (ALERTS{pack="${p}", alertstate="pending", ${sel}})${baseline ? ' or label_replace(vector(0), "alertname", "no alert", "", "")' : ''}`; };

/**
 * The 1 h burn per SLO as a bar gauge. `sloIds` narrows it to the SLOs a board binds
 * (`{slo=~"a|b"}`, ids are identifiers); when it names every SLO of the pack, matches none of
 * them, or is not given, the expression is the bare series (every SLO), so the unified boards and
 * a module's own boards are unchanged and no board ever carries the empty selector `{slo=~""}`.
 * The overrides (label and thresholds per SLO) follow the same list.
 */
export const burnBars = (binds, w = 12, h = 8, sloIds) => {
  const c = ctx(); const all = c.pack.spec.slos || [];
  const named = all.filter(s => sloIds?.includes(s.id));
  const subset = named.length > 0 && named.length < all.length;
  const slos = subset ? named : all;
  return bargauge('Error-budget burn · last hour', `${c.svc}:errorbudget:burn_1h${subset ? `{slo=~"${slos.map(s => s.id).join('|')}"}` : ''}`, {
    binds, legend: '{{slo}}', decimals: 1, min: 0, max: 20, w, h,
    // Grafana scales a bar gauge's name and value with the panel height: two or three bars in an
    // 8-high panel came out as 60 px truncated names (measured on grafana-plugins-and-auth), so a
    // gauge with few bars pins its text; a full column of eight sizes itself sensibly.
    text: slos.length <= 3 ? { titleSize: 16, valueSize: 28 } : undefined,
    desc: '1 h error-budget burn rate per SLO: 1× consumes the budget exactly over the SLO window; amber at the smallest factor that alerts for that SLO, red at the largest (spec.policy).',
    overrides: slos.map(s => { const { warn, bad } = burnFactors(s.id); return byName(s.id, { displayName: c.sloLabel[s.id], thresholds: { mode: 'absolute', steps: okAbove(warn, bad) } }); }),
  });
};
/**
 * One stat per SLO with its 1 h burn, coloured by the SLO's own policy factors: the tiles of a
 * burn-template board, and what stands in for the bar gauge when a board binds a single SLO
 * (one bar has nothing to compare with and sat in a mostly empty panel). `widths` per tile
 * (tileRows(n).flat() fills the rows), `h` their height.
 */
export const burnTiles = (sloIds, { widths = tileRows(sloIds.length).flat(), h = 4 } = {}) => {
  const c = ctx(); const slos = (c.pack.spec.slos || []).filter(s => sloIds.includes(s.id));
  return slos.map((s, i) => stat(`${c.sloRename[s.id]} · burn 1 h`, `${c.svc}:errorbudget:burn_1h{slo="${s.id}"}`, { binds: `slos.${s.id}`, desc: `1 h burn rate of ${c.sloLabel[s.id]} (objective ${s.objective} over ${s.window}).`, decimals: 1, thresholds: burnThresholds(s.id), w: widths[i] ?? 4, h }));
};
export const burnCurves = (w, legend = 'auto') => { const c = ctx(); return [
  ts('Burn rate · 5 m window', [{ expr: `${c.svc}:errorbudget:burn_5m`, legend: '{{slo}}' }], { desc: 'Fast window: reacts within minutes; pages when both it and the slow window exceed the factor. Hover for per-SLO values.', unit: 'short', decimals: 1, w, h: 8, legend, rename: c.sloRename, lines: [{ value: 1, color: C.slate }, { value: 14, color: C.red }] }),
  ts('Burn rate · 1 h window', [{ expr: `${c.svc}:errorbudget:burn_1h`, legend: '{{slo}}' }], { desc: 'Slow window: keeps burning for up to an hour after an incident by design.', unit: 'short', decimals: 1, w, h: 8, legend, rename: c.sloRename, lines: [{ value: 1, color: C.slate }, { value: 6, color: C.red }] }),
]; };
export const alertTimelines = (w, h) => [
  timeline('Symptom alerts · pending / firing', [{ expr: alertState('burn_rate="", kind=""'), legend: '{{alertname}}' }], { desc: 'State of every symptom alert of the pack over the time range.', mappings: STATE_ALERT, w, h, legend: false }),
  timeline('Burn-rate & forecast alerts · pending / firing', [{ expr: alertState('burn_rate!=""'), legend: '{{alertname}}' }, { expr: alertState('kind="forecast"', false), legend: '{{alertname}}' }], { desc: 'Multi-window burn-rate alerts (fast windows page, slow windows linger after incidents) and forecasts.', mappings: STATE_ALERT, w, h, legend: false }),
];
export const alertTable = (w, h) => table('Firing pack alerts', [{ expr: `ALERTS{pack="${ctx().packName}", alertstate="firing"}`, instant: true, format: 'table' }], {
  desc: 'Everything currently firing with the pack label, most severe first.', w, h, sortBy: { displayName: 'severity', desc: false },
  transformations: [{ id: 'organize', options: { excludeByName: { Time: true, Value: true, __name__: true, pack: true, service: true, alertstate: true, instance: true, job: true }, indexByName: { alertname: 0, severity: 1, slo: 2, sli: 3, qmgr: 4, queue: 5 } } }],
  overrides: [byName('severity', { 'custom.cellOptions': { type: 'color-background', mode: 'basic' }, 'custom.width': 80, mappings: [{ type: 'value', options: { SEV1: { color: C.red, text: 'SEV1' }, SEV2: { color: C.amber, text: 'SEV2' }, SEV3: { color: C.blue, text: 'SEV3' } } }] }), byName('alertname', { 'custom.width': 300 })],
});
export const alertCounters = (w = 4) => { const p = ctx().packName; return [
  stat('Symptom alerts firing', `count(ALERTS{alertstate="firing", pack="${p}", burn_rate="", kind=""}) or vector(0)`, { decimals: 0, spark: false, thresholds: okAbove(1, 1), w }),
  stat('Burn-rate alerts firing', `count(ALERTS{alertstate="firing", pack="${p}", burn_rate!=""}) or vector(0)`, { decimals: 0, spark: false, thresholds: okAbove(1, 1), w }),
  stat('Forecast alerts firing', `count(ALERTS{alertstate="firing", pack="${p}", kind="forecast"}) or vector(0)`, { decimals: 0, spark: false, thresholds: okAbove(1, 1), w }),
]; };

// §10 baselines & validation: what the harness measured in the last certification run
// (published to the alert-sink, scraped as job "certification").
export const certTiles = () => { const { certSel: CERT, base: BASE } = ctx(); return [
  stat('Last certification', `max(mq_cert_verdict_code{${CERT}})`, { desc: 'Verdict of the last `npm run certify` published to the alert-sink: PASS, WARN, FAIL or ERROR.', mappings: STATE_VERDICT, mode: 'solid', thresholds: [{ color: C.green, value: null }, { color: C.amber, value: 1 }, { color: C.red, value: 2 }], w: 4 }),
  stat('Certified', `max(mq_cert_run_timestamp_seconds{${CERT}}) * 1000`, { desc: 'When the last certification run finished.', unit: 'dateTimeFromNow', mode: 'none', spark: false, w: 4 }),
  stat('MTTD p50', `max(mq_cert_mttd_quantile_seconds{${CERT}, quantile="0.5"})`, { desc: `Median time from fault injection to the alert webhook, across every expected alert of the chaos suite. Baseline p50 ${fmtS(BASE.mttdP50)} (pack spec.baselines).`, unit: 'suffix: s', decimals: 1, spark: false, thresholds: okAbove(BASE.mttdP50, BASE.mttdP95), w: 4 }),
  stat('MTTD p95', `max(mq_cert_mttd_quantile_seconds{${CERT}, quantile="0.95"})`, { desc: `95th percentile time to detect. Baseline p95 ${fmtS(BASE.mttdP95)}.`, unit: 'suffix: s', decimals: 1, spark: false, thresholds: okAbove(BASE.mttdP95, BASE.mttdP95 * 2), w: 4 }),
  stat('MTTR p50 · resolution', `max(mq_cert_mttr_quantile_seconds{${CERT}, quantile="0.5"})`, { desc: `Median time from the recovery action to the resolved webhook: the observability system's share of MTTR (it excludes the human/automation fix time). Baseline MTTR p50 ${fmtS(BASE.mttrP50)}.`, unit: 'suffix: s', decimals: 1, spark: false, thresholds: okAbove(BASE.mttrP50, BASE.mttrP95), w: 4 }),
  stat('MTTR p95 · resolution', `max(mq_cert_mttr_quantile_seconds{${CERT}, quantile="0.95"})`, { desc: `95th percentile resolution after recovery. Baseline MTTR p95 ${fmtS(BASE.mttrP95)}.`, unit: 'suffix: s', decimals: 1, spark: false, thresholds: okAbove(BASE.mttrP95, BASE.mttrP95 * 2), w: 4 }),
]; };
export const mttdBars = (w = 12, h = 8) => { const c = ctx(); const chaos = c.pack.spec.validation?.chaos_experiments || []; return bargauge('MTTD per expected alert · against its budget', `mq_cert_mttd_seconds{${c.certSel}}`, {
  legend: '{{experiment}} · {{alertname}}', unit: 'suffix: s', decimals: 1, min: 0, max: Math.max(...chaos.map(e => secondsOf(e.expected_mttd || '60s'))) * 1.2, w, h,
  desc: 'Time from injection to the firing webhook for each expected alert in the last run; amber from 75 % of the experiment\'s expected_mttd, red at the budget.',
  overrides: chaos.flatMap(e => (e.expected_alerts || []).map(a => { const t = secondsOf(e.expected_mttd || '60s'); return byName(`${e.id} · ${a}`, { thresholds: { mode: 'absolute', steps: okAbove(t * 0.75, t) } }); })),
}); };
export const mttrBars = (w = 12, h = 8) => bargauge('Resolution after recovery · per alert', `mq_cert_mttr_seconds{${ctx().certSel}}`, {
  legend: '{{experiment}} · {{alertname}}', unit: 'suffix: s', decimals: 1, min: 0, max: 120, w, h, thresholds: okAbove(60, 120),
  desc: 'Time from the recovery action to the resolved webhook in the last run (Prometheus resolve + Alertmanager group_interval + webhook).',
});
export const certCounts = () => { const CERT = ctx().certSel; return [
  stat('Conformance passed', `sum(mq_cert_checks{${CERT}, suite="conformance", status="PASS"})`, { desc: 'C1-C10: does the stack implement the pack?', decimals: 0, mode: 'none', spark: false, w: 4 }),
  stat('Synthetic passed', `sum(mq_cert_checks{${CERT}, suite="synthetic", status="PASS"})`, { desc: 'S1-S6: canary, orders flow, no symptom or fast-window burn alert firing.', decimals: 0, mode: 'none', spark: false, w: 4 }),
  stat('Chaos passed', `sum(mq_cert_checks{${CERT}, suite="chaos", status="PASS"})`, { desc: 'Experiments whose alerts fired within budget, resolved after recovery, and whose hypothesis SLI moved as declared.', decimals: 0, mode: 'none', spark: false, w: 4 }),
  stat('Checks failed', `sum(mq_cert_checks{${CERT}, status=~"FAIL|ERROR"}) or vector(0)`, { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 4 }),
  stat('Run duration', `max(mq_cert_run_duration_seconds{${CERT}})`, { unit: 's', decimals: 0, mode: 'none', spark: false, w: 4 }),
  stat('Webhooks in the ledger', `max(mq_alert_sink_events{${CERT}})`, { desc: 'Alertmanager webhook events held by the alert-sink (MTTD is measured from their receipt time).', decimals: 0, mode: 'none', spark: false, w: 4 }),
]; };
// §9 remediation, straight from the pack: which alert triggers which runbook and automation,
// with the declared guardrails (declared for the platform; nothing in the lab enforces them).
export function remediationTable() {
  const c = ctx();
  const rows = (c.pack.spec.remediation || []).map(r => {
    const alert = String(r.trigger).replace(/^alert:/, '');
    const rb = String(r.runbook || '').replace(/^file:\/\//, '');
    const g = r.guardrails || {};
    const guard = [g.max_invocations_per_hour != null ? `≤ ${g.max_invocations_per_hour}/h` : null, g.requires_human_above ? `human above ${g.requires_human_above}` : null, g.cooldown_after_success ? `cooldown ${g.cooldown_after_success}` : null].filter(Boolean).join(' · ');
    const link = c.repoUrl ? `[${rb.replace(/^runbooks\//, '')}](${c.repoUrl}/${rb})` : `\`${rb}\``;
    return `| \`${alert}\` | ${link} | \`${String(r.automation || 'manual-only').replace(/^argo-workflow:\/\//, '')}\` | ${guard || '—'} |`;
  });
  return text(`| Trigger | Runbook | Automation (declared) | Guardrails (declared) |\n|---|---|---|---|\n${rows.join('\n')}\n\n<small>Automations and guardrails come from the pack's \`remediation\` section for the platform to implement; in this lab every action is done by hand, as the runbooks say.</small>`, { title: 'Remediation · runbooks and guardrails', h: 7 });
}

// ---------------------------------------------------------------- derived from any pack
/** The recording rule that materialises an SLI (`expr: ref:slis.<id>`), if the pack declares one. */
export function recordedSeries(pack, sliId) {
  const r = (pack.spec.queries?.recording_rules || []).find(x => String(x.expr || '').trim() === `ref:slis.${sliId}`);
  return r ? r.name : null;
}
const strip = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Executable PromQL for an SLI (its recording rule when it has one, else its own expression). */
export function sliExpr(pack, sli) {
  const rec = recordedSeries(pack, sli.id);
  if (sli.type === 'ratio') return rec || `(${strip(sli.good)}) / (${strip(sli.total)})`;
  return rec ? `max(${rec})` : `max(${strip(sli.query || sli.expression)})`;
}
const UNIT = { seconds: 's', ratio: 'percentunit', percent: 'percent', bytes: 'bytes', messages: 'none', events_per_hour: 'none' };
/**
 * The colour steps of a threshold SLI's tile, oriented by its direction (spec 1.3 good_when, read
 * through goodWhen: absent means below): a ceiling colours okAbove — higher is worse — amber at the
 * bound and red at twice it; a floor (good_when: above) colours okBelow — lower is worse — amber
 * under the bound and red under half of it (the same distance, mirrored; `t - |t| / 2` keeps the
 * steps ascending for a negative bound too). The dashed line sits at the bound either way.
 *
 * A bound of 0 has no amber band (twice 0 and half of 0 are 0): the two steps would coincide and
 * Grafana, which paints the last step whose value is <= the sample, would paint the good 0 of a
 * ceiling red. So a ceiling at 0 is green up to and including 0 and red from the smallest value
 * above it (Number.MIN_VALUE — 5e-324 in the board JSON — is "strictly above 0" for a double),
 * and a floor at 0 is red under 0 and green from 0: the bound itself stays good, as the burn
 * rules count it.
 */
export function thresholdSteps(sli) {
  const t = Number(sli.threshold);
  if (goodWhen(sli) === 'above') return t === 0 ? [{ color: C.red, value: null }, { color: C.green, value: 0 }] : okBelow(t, t - Math.abs(t) / 2);
  return t === 0 ? [{ color: C.green, value: null }, { color: C.red, value: Number.MIN_VALUE }] : okAbove(t, t * 2);
}
/**
 * One stat tile per SLI, derived from the pack: ratio SLIs colour against the objective of the
 * first SLO on them (amber under it, red ten budgets below); threshold SLIs colour against the
 * threshold in the direction of the SLI (thresholdSteps) and their description names the bound
 * with its direction (`good when ≤ 0.5 seconds`, `≥ 2 consumers`). A pack module can replace these
 * with hand-written tiles. `widths` gives each tile its own width (splitWidths(n) fills the row
 * exactly); `w` is one width for all of them; `h` the tiles' height (8 when a tile shares a row
 * with the burn panels).
 */
export function derivedSliTiles(pack, sliIds, { w = 3, h = 4, widths } = {}) {
  const slis = (pack.spec.slis || []).filter(s => !sliIds || sliIds.includes(s.id));
  return slis.map((sli, i) => {
    const slo = (pack.spec.slos || []).find(s => s.sli === sli.id);
    const desc = strip(sli.description || '') + (slo ? ` SLO ${pct(slo.objective)} over ${slo.window}.` : '');
    const tw = widths?.[i] ?? w;
    if (sli.type === 'ratio') {
      const obj = Number(slo?.objective ?? 0.99), budget = 1 - obj;
      return stat(humanize(sli.id).replace(/ ratio$/i, ''), sliExpr(pack, sli), { binds: `slis.${sli.id}`, desc, unit: 'percentunit', decimals: 2, thresholds: okBelow(obj, Math.max(0, obj - 10 * budget)), w: tw, h });
    }
    const unit = UNIT[sli.unit] ?? 'none';
    const bound = boundText(sli);
    return stat(humanize(sli.id), sliExpr(pack, sli), { binds: `slis.${sli.id}`, desc: `${desc}${bound ? ` Good when ${bound}.` : ''}`, unit, decimals: unit === 's' ? 2 : unit === 'percentunit' ? 1 : 0, thresholds: thresholdSteps(sli), w: tw, h });
  });
}
/**
 * The SLI over time with its line to hold — the objective of the first SLO on a ratio SLI, the
 * threshold of a threshold SLI (at the bound whichever way the SLI faces; the description says
 * which side is good) — dashed across it. It completes the row of a lone tile: a single SLI
 * stretched to w24 was a banner-wide number with a sparkline, so the tile sits w6 h8 beside this
 * graph instead.
 */
export function derivedSliTrend(pack, sli, { w = 18, h = 8 } = {}) {
  const slo = (pack.spec.slos || []).find(s => s.sli === sli.id);
  const ratio = sli.type === 'ratio';
  const unit = ratio ? 'percentunit' : (UNIT[sli.unit] ?? 'none');
  const line = ratio ? (slo ? Number(slo.objective) : NaN) : Number(sli.threshold);
  const title = ratio ? humanize(sli.id).replace(/ ratio$/i, '') : humanize(sli.id);
  return ts(`${title} · over time`, [{ expr: sliExpr(pack, sli), legend: sli.id }], {
    binds: `slis.${sli.id}`, desc: `${strip(sli.description || '')}${Number.isFinite(line) ? ` The dashed line is the ${ratio ? `objective ${pct(line)}` : `threshold — good when ${boundText(sli)}`}.` : ''}`.trim(),
    unit, decimals: unit === 's' ? 2 : unit === 'percentunit' ? 2 : 0, legend: 'hidden', w, h,
    lines: Number.isFinite(line) ? [{ value: line, color: C.amber }] : undefined,
  });
}
/** Whether derivedViewPanel renders a view as a time series (a metric, or an SLI the pack declares) rather than a note. */
export const viewRenders = (pack, view) => Boolean(view?.params?.metric || (pack.spec.slis || []).some(s => s.id === view?.params?.sli));
/**
 * A derived view (`spec.queries.derived_views[]` bound to ref:platform/per-resource-rollup):
 * `metric` + `by` becomes a per-label time series (rate for counters), `sli` + `by` the SLI's
 * legs grouped by the label. `metric` may carry a label selector (`x_total{topic!=""}`): a
 * counter is still rated, and the selector drops series the rollup should not show — the
 * JMX exporter's broker-wide `kafka_server_brokertopicmetrics_messagesin_total` has no `topic`
 * label and would otherwise appear as a `{}` series equal to the sum of the others (measured).
 * `w` is the panel's width (viewWidths(n) for a run of views); a view with neither a metric nor
 * a declared SLI is a w24 note on a row of its own, whatever `w` says.
 */
export function derivedViewPanel(pack, view, binds, { w } = {}) {
  const by = (view.params?.by || []).join(', ');
  const legend = (view.params?.by || []).map(b => `{{${b}}}`).join(' ') || '__auto';
  const title = humanize(view.id);
  if (!viewRenders(pack, view)) return text(`Derived view \`${view.id}\`: no metric or SLI to render.`, { title, h: 3 });
  if (view.params?.metric) {
    const m = view.params.metric;
    const counter = /_total(\{[^}]*\})?$/.test(m);
    const expr = counter ? `sum by (${by}) (rate(${m}[5m]))` : `max by (${by}) (${m})`;
    return ts(title, [{ expr, legend }], { binds, desc: `Per-resource rollup of ${m} by ${by} (pack derived view ${view.id}).`, many: true, unit: counter ? 'ops' : 'none', w });
  }
  const sli = (pack.spec.slis || []).find(s => s.id === view.params?.sli);
  const grouped = (e) => strip(e).replace(/\bsum\(/g, `sum by (${by}) (`).replace(/\bcount\(/g, `count by (${by}) (`).replace(/\bmax\(/g, `max by (${by}) (`);
  const expr = sli.type === 'ratio' ? `(${grouped(sli.good)}) / (${grouped(sli.total)})` : grouped(sli.query || sli.expression);
  return ts(title, [{ expr, legend }], { binds, desc: `SLI ${sli.id} by ${by} (pack derived view ${view.id}).`, many: true, unit: sli.type === 'ratio' ? 'percentunit' : (UNIT[sli.unit] ?? 'none'), w });
}
