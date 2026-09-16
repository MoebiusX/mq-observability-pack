#!/usr/bin/env node
// Generates stack/prometheus/rules/ibmmq.burn.yml from packs/ibmmq.pack.yaml:
//
//   spec.policy.burn_rate_alerts  → one multi-window burn-rate alert per declared window
//   spec.policy.forecasts         → one predict_linear forecast alert per entry
//   plus the error-budget recording rules the dashboards read
//   (ibmmq:errorbudget:burn_5m / burn_1h per SLO, ibmmq:<sli>:error_ratio_5m for threshold SLIs)
//
// Naming, labels, annotations and grouping follow Observogram's compiler
// (tools/lib/compile.mjs, compilePrometheusRules): alert `<slo>_burn_<factor>x_<short>_<long>`,
// labels severity/slo/sli/service/burn_rate/window_short/window_long, group `<svc>_<slo>_burn`,
// forecast alert `<slo>_forecast_breach` with `kind: forecast`. Two deliberate deviations,
// both because that compiler only knows rate-style ratio SLIs:
//   - state-style ratio SLIs (good = sum(up == bool 1), sum(status == bool 2)) are
//     time-averaged over the window with avg_over_time instead of being wrapped in rate();
//   - threshold SLIs get an error ratio = fraction of the window in which the SLI breached
//     its threshold: avg_over_time((max(<recorded SLI>) > bool <threshold>)[w:10s]).
// `for:` is lab-tuned (30 s / 2 m / 5 m by short window); the compiler's production
// defaults are 2 m / 5 m / 10 m (CLAUDE.md rule 7).
//
// Never hand-edit the output; `npm run burn-rules` regenerates it and CI diffs it.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from '../vendor/observogram/lib/mini-yaml.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = 'packs/ibmmq.pack.yaml';
const OUT = 'stack/prometheus/rules/ibmmq.burn.yml';
const SUBQ = '10s';                       // subquery resolution = lab scrape interval
const pack = parseYaml(readFileSync(resolve(root, PACK), 'utf8'));
const svc = pack.metadata.name;           // "ibmmq"
const slis = Object.fromEntries(pack.spec.slis.map(s => [s.id, s]));
const slos = Object.fromEntries(pack.spec.slos.map(s => [s.id, s]));
const strip = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const num = (x) => Number(x).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
const RANGE = /\[\s*\d+(?:\.\d+)?(?:ms|s|m|h|d)\s*\]/g;
const hasRange = (e) => /\[\s*\d+(?:\.\d+)?(?:ms|s|m|h|d)\s*\]/.test(e);
const RUNBOOK = {
  qmgr_process_up: 'runbooks/qmgr-down.md', qmgr_reachability: 'runbooks/qmgr-unreachable.md',
  queue_depth_headroom: 'runbooks/queue-depth.md', oldest_message_age: 'runbooks/consumer-stalled.md',
  dlq_depth: 'runbooks/dlq.md', canary_success: 'runbooks/canary.md',
};

/** Name of the pack recording rule that materialises a threshold SLI (expr: ref:slis.<id>). */
function recordedSeries(sliId) {
  const r = (pack.spec.queries?.recording_rules || []).find(x => strip(x.expr) === `ref:slis.${sliId}`);
  if (!r) throw new Error(`threshold SLI ${sliId} has no recording rule with expr ref:slis.${sliId}`);
  return r.name;
}

/** PromQL for the error ratio of an SLO over window w (one instant vector, no labels). */
function errorRatioAt(slo, w) {
  const sli = slis[slo.sli];
  if (!sli) throw new Error(`SLO ${slo.id}: unknown SLI ${slo.sli}`);
  if (sli.type === 'ratio') {
    const good = strip(sli.good), total = strip(sli.total);
    if (hasRange(good)) {
      // rate-style legs (canary): swap the declared window for w, as the compiler does
      return `(1 - ${good.replace(RANGE, `[${w}]`)} / ${total.replace(RANGE, `[${w}]`)})`;
    }
    // state-style legs: sum(<state> == bool 1) → time-average the boolean over the window
    const m = /^sum\(([\s\S]*)\)$/.exec(good);
    if (!m) throw new Error(`SLI ${sli.id}: cannot derive a windowed error ratio from good=${good}`);
    return `(1 - sum(avg_over_time((${m[1].trim()})[${w}:${SUBQ}])) / ${total})`;
  }
  if (sli.type === 'threshold') {
    return `avg_over_time((max(${recordedSeries(sli.id)}) > bool ${num(sli.threshold)})[${w}:${SUBQ}])`;
  }
  throw new Error(`SLI ${sli.id}: unsupported type ${sli.type}`);
}

/** Series name holding the 5m error ratio of an SLO's SLI (pack-declared for ratio SLIs, generated here for threshold SLIs). */
const errorRatio5mSeries = (slo) => `${svc}:${slo.sli}:error_ratio_5m`;

const labFor = (short) => { const s = /^(\d+)m$/.exec(short) ? Number(short.slice(0, -1)) * 60 : /^(\d+)h$/.exec(short) ? Number(short.slice(0, -1)) * 3600 : 300; return s <= 300 ? '30s' : s <= 1800 ? '2m' : '5m'; };
const horizonSec = (d) => { const m = /^(\d+)(m|h|d)$/.exec(d || '7d'); const n = Number(m?.[1] || 7); return ({ m: 60, h: 3600, d: 86400 })[m?.[2] || 'd'] * n; };

// ----------------------------------------------------------------- recording
const recording = [];
for (const slo of pack.spec.slos) {
  const sli = slis[slo.sli];
  if (sli.type === 'threshold') {
    recording.push({ record: errorRatio5mSeries(slo), expr: errorRatioAt(slo, '5m'), labels: { slo: slo.id, sli: sli.id, service: svc } });
  }
}
for (const slo of pack.spec.slos) {
  const budget = num(1 - slo.objective);
  for (const w of ['5m', '1h']) {
    recording.push({ record: `${svc}:errorbudget:burn_${w}`, expr: `${errorRatioAt(slo, w)} / ${budget}`, labels: { slo: slo.id, sli: slo.sli, service: svc } });
  }
}

// ----------------------------------------------------------------- burn-rate alerts
const groups = [{ name: `${svc}.errorbudget`, interval: '30s', rules: recording }];
let burnCount = 0;
for (const ba of pack.spec.policy.burn_rate_alerts) {
  const slo = slos[ba.slo];
  if (!slo) throw new Error(`policy references unknown SLO ${ba.slo}`);
  const sli = slis[slo.sli];
  const budget = 1 - slo.objective;
  const rules = [];
  for (const w of ba.windows) {
    const factor = w.factor, short = w.short, long = w.long;
    const threshold = num(factor * budget);
    const name = `${slo.id}_burn_${factor}x_${short}_${long}`.replace(/[^a-zA-Z0-9_]/g, '_');
    rules.push({
      alert: name,
      expr: `(\n  ${errorRatioAt(slo, short)} > ${threshold}\n) and (\n  ${errorRatioAt(slo, long)} > ${threshold}\n)`,
      for: labFor(short),
      labels: { severity: w.severity, pack: svc, slo: slo.id, sli: sli.id, service: svc, burn_rate: String(factor), window_short: short, window_long: long },
      annotations: {
        summary: `Burn rate ${factor}x on ${slo.id}`,
        description: `Both the ${short} and ${long} error ratios exceed ${factor}x of the ${num(budget * 100)}% error budget for ${slo.id} (objective ${num(slo.objective * 100)}% over ${slo.window}).`,
        slo_objective: `${num(slo.objective * 100)}%`,
        slo_window: String(slo.window),
        ...(RUNBOOK[sli.id] ? { runbook: RUNBOOK[sli.id] } : {}),
      },
    });
    burnCount++;
  }
  groups.push({ name: `${svc}_${slo.id}_burn`, interval: '30s', rules });
}

// ----------------------------------------------------------------- forecast alerts
const forecasts = [];
for (const f of pack.spec.policy.forecasts || []) {
  const slo = slos[f.slo];
  if (!slo) throw new Error(`forecast references unknown SLO ${f.slo}`);
  forecasts.push({
    alert: `${slo.id}_forecast_breach`,
    expr: `predict_linear(${errorRatio5mSeries(slo)}[1h], ${horizonSec(f.horizon)}) > ${num(1 - slo.objective)}`,
    for: '15m',
    labels: { severity: 'SEV3', pack: svc, slo: slo.id, sli: slo.sli, service: svc, kind: 'forecast' },
    annotations: {
      summary: `${slo.id} projected to breach its error budget within ${f.horizon || '7d'}`,
      method: f.method || 'linear',
      horizon: String(f.horizon || '7d'),
      on_projected_breach: f.on_projected_breach || 'open_ticket',
    },
  });
}
if (forecasts.length) groups.push({ name: `${svc}.forecast`, interval: '1m', rules: forecasts });

// ----------------------------------------------------------------- YAML (subset mini-yaml and promtool both read)
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_.:/%-]*$/;
const scalar = (v) => (typeof v === 'number' ? String(v) : PLAIN.test(v) && !/^(true|false|null|yes|no|on|off)$/i.test(v) && !/^[0-9.]+$/.test(v) ? v : JSON.stringify(v));
function emitMap(obj, ind) {
  const pad = ' '.repeat(ind), lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (Array.isArray(v)) { lines.push(`${pad}${k}:`); lines.push(...emitSeq(v, ind + 2)); }
    else if (typeof v === 'object') { lines.push(`${pad}${k}:`); lines.push(...emitMap(v, ind + 2)); }
    else if (typeof v === 'string' && v.includes('\n')) { lines.push(`${pad}${k}: |`); for (const l of v.split('\n')) lines.push(`${pad}  ${l}`); }
    else lines.push(`${pad}${k}: ${scalar(v)}`);
  }
  return lines;
}
function emitSeq(arr, ind) {
  const pad = ' '.repeat(ind), lines = [];
  for (const item of arr) {
    const m = emitMap(item, ind + 2);
    lines.push(`${pad}- ${m[0].slice(ind + 2)}`, ...m.slice(1));
  }
  return lines;
}
const header = [
  `# GENERATED by tools/gen-burn-rules.mjs from ${PACK} (spec.policy) — do not edit.`,
  '# Multi-window burn-rate alerts (one per declared window), forecast alerts and the',
  '# error-budget recording rules. Names/labels follow Observogram\'s compiler; see the',
  '# generator header for the two PromQL deviations. Regenerate: npm run burn-rules',
  '',
];
if (process.argv.includes('--pack-snippet')) {
  // The pack declares every recording rule the stack records (CLAUDE.md rule 1); print the
  // generated ones in the pack's list shape so spec.queries.recording_rules can be kept in
  // sync by paste. check-rules compares these expressions with the stack verbatim.
  for (const r of recording) {
    console.log(`      - name: ${r.record}`);
    console.log(`        expr: '${r.expr.replace(/'/g, "''")}'`);
    console.log(`        interval: 30s`);
    console.log(`        labels: { slo: ${r.labels.slo}, sli: ${r.labels.sli}, service: ${r.labels.service} }`);
  }
  process.exit(0);
}
writeFileSync(resolve(root, OUT), header.concat(['groups:'], emitSeq(groups, 2), ['']).join('\n'));
console.log(`${OUT}: ${recording.length} recording rules, ${burnCount} burn-rate alerts, ${forecasts.length} forecast alerts`);
