#!/usr/bin/env node
// Generates stack/prometheus/rules/ibmmq.burn.yml from packs/ibmmq.pack.yaml:
//
//   spec.policy.burn_rate_alerts  → one multi-window burn-rate alert per declared window
//   spec.policy.forecasts         → one forecast alert per entry
//   plus the error-budget recording rules the dashboards read
//   (ibmmq:errorbudget:burn_5m / burn_1h per SLO, ibmmq:<sli>:error_ratio_5m for threshold SLIs)
//
// Naming, labels, annotations and grouping follow Observogram's compiler
// (tools/lib/compile.mjs, compilePrometheusRules): alert `<slo>_burn_<factor>x_<short>_<long>`,
// labels severity/slo/sli/service/burn_rate/window_short/window_long, group `<svc>_<slo>_burn`,
// forecast alert `<slo>_forecast_breach` with `kind: forecast`.
//
// Five deliberate deviations from that compiler's PromQL, each found by running the rules
// against the live lab (docs/catalogue-evidence/ibmmq.md §8):
//   1. Error ratios count BAD SAMPLES over the EXPECTED number of samples in the window
//      (window / 10 s), not over the samples that happen to exist. avg_over_time/rate over a
//      partly-filled window is a since-start average on a fresh TSDB, which made every 6 h
//      window fire after the first 90 s fault of a session. Time with no samples therefore
//      counts as good; the symptom alerts (IBMMQQueueManagerDown, IBMMQExporterDown,
//      MQCanaryFailing's absent()) own the "no data" failure mode.
//      - state-style ratio SLIs (good = sum(<state> == bool 1)): bad = sum_over_time of (1 - state)
//      - rate-style ratio SLIs (canary counters): bad = increase(total) - increase(ok)
//      - threshold SLIs: bad = samples of the recorded SLI above its threshold (all upper bounds)
//   2. The short window additionally needs at least MIN_BAD_SAMPLES bad samples/probes: with the
//      long leg loaded by an incident, one bad 10 s sample in 5 m (3.3 %) already exceeds a
//      14 × 0.1 % threshold and re-fired SEV1 for the rest of the hour.
//   3. Forecast alerts regress the recorded 1 h burn rate over 1 d and require it to have been
//      above 1× for 2 h; the compiler's predict_linear on the 5 m error ratio fired ~15 min after
//      every transient outage (measured: 28 min of "breach within 7 d" after a 2 min stop).
//      Every pack forecast method is implemented as this linear rule in the lab.
//   4. `for:` is lab-tuned (30 s / 2 m / 5 m by short window); the compiler uses 2 m / 5 m / 10 m.
//   5. The forecast horizon is capped at the 1 d regression window (a 7 d extrapolation of a
//      1 d slope is 7× more sensitive); the annotation says which horizon was evaluated and the
//      severity follows on_projected_breach (page_oncall → SEV1, open_ticket → SEV2, else SEV3).
//
// Never hand-edit the output; `npm run burn-rules` regenerates it and CI diffs it.
// `--pack-snippet` prints the generated recording rules for spec.queries.recording_rules.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from '../vendor/observogram/lib/mini-yaml.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = 'packs/ibmmq.pack.yaml';
const OUT = 'stack/prometheus/rules/ibmmq.burn.yml';
const STEP_SEC = 10;                      // scrape interval = canary probe interval = subquery step
const SUBQ = `${STEP_SEC}s`;
const MIN_BAD_SAMPLES = 2;                // deviation 2
const FORECAST_SEVERITY = { page_oncall: 'SEV1', open_ticket: 'SEV2', post_warning: 'SEV3' };   // deviation 5
const pack = parseYaml(readFileSync(resolve(root, PACK), 'utf8'));
const svc = pack.metadata.name;           // "ibmmq"
const slis = Object.fromEntries(pack.spec.slis.map(s => [s.id, s]));
const slos = Object.fromEntries(pack.spec.slos.map(s => [s.id, s]));
const strip = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const num = (x) => Number(x).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
const RANGE = /\[\s*\d+(?:\.\d+)?(?:ms|s|m|h|d|w)\s*\]/g;
const hasRange = (e) => /\[\s*\d+(?:\.\d+)?(?:ms|s|m|h|d|w)\s*\]/.test(e);
const UNITS = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
function durationSeconds(d) {
  let total = 0, m; const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g;
  while ((m = re.exec(String(d ?? '')))) total += Number(m[1]) * UNITS[m[2]];
  if (!(total > 0)) throw new Error(`cannot parse duration ${JSON.stringify(d)}`);
  return total;
}
const expectedSamples = (w) => Math.round(durationSeconds(w) / STEP_SEC);
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

/**
 * { bad, denom } for an SLO over window w: `bad` counts bad samples/probes in the window,
 * `denom` the expected number, both as PromQL. error ratio = bad / denom.
 */
function legs(slo, w) {
  const sli = slis[slo.sli];
  if (!sli) throw new Error(`SLO ${slo.id}: unknown SLI ${slo.sli}`);
  const n = expectedSamples(w);
  if (sli.type === 'ratio') {
    const good = strip(sli.good), total = strip(sli.total);
    if (hasRange(good)) {
      // rate-style counters (canary): failed probes = increase(total) - increase(ok)
      const toInc = (e) => e.replace(/\brate\(/g, 'increase(').replace(RANGE, `[${w}]`);
      return { bad: `((${toInc(total)}) - (${toInc(good)}))`, denom: String(n) };
    }
    // state-style: good = sum(<state> == bool 1) → bad samples = sum over series of (1 - state)
    const m = /^sum\(([\s\S]*)\)$/.exec(good);
    if (!m) throw new Error(`SLI ${sli.id}: cannot derive bad samples from good=${good}`);
    return { bad: `sum(sum_over_time((1 - (${m[1].trim()}))[${w}:${SUBQ}]))`, denom: `((${total}) * ${n})` };
  }
  if (sli.type === 'threshold') {
    if (!(Number(sli.threshold) >= 0)) throw new Error(`threshold SLI ${sli.id}: threshold must be a non-negative upper bound`);
    return { bad: `sum_over_time((max(${recordedSeries(sli.id)}) > bool ${num(sli.threshold)})[${w}:${SUBQ}])`, denom: String(n) };
  }
  throw new Error(`SLI ${sli.id}: unsupported type ${sli.type}`);
}
const errorRatioAt = (slo, w) => { const { bad, denom } = legs(slo, w); return `(${bad} / ${denom})`; };
const badCountAt = (slo, w) => legs(slo, w).bad;

const labFor = (short) => { const s = durationSeconds(short); return s <= 300 ? '30s' : s <= 1800 ? '2m' : '5m'; };

// ----------------------------------------------------------------- recording
const recording = [];
for (const slo of pack.spec.slos) {
  const sli = slis[slo.sli];
  if (sli.type === 'threshold') {
    recording.push({ record: `${svc}:${sli.id}:error_ratio_5m`, expr: errorRatioAt(slo, '5m'), labels: { slo: slo.id, sli: sli.id, service: svc } });
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
      expr: [
        '(',
        `  ${errorRatioAt(slo, short)} > ${threshold}`,
        ') and (',
        `  ${errorRatioAt(slo, long)} > ${threshold}`,
        ') and (',
        `  ${badCountAt(slo, short)} >= ${MIN_BAD_SAMPLES}`,
        ')',
      ].join('\n'),
      for: labFor(short),
      labels: { severity: w.severity, pack: svc, slo: slo.id, sli: sli.id, service: svc, burn_rate: String(factor), window_short: short, window_long: long },
      annotations: {
        summary: `Burn rate ${factor}x on ${slo.id}`,
        description: `Both the ${short} and ${long} error ratios exceed ${factor}x of the ${num(budget * 100)}% error budget for ${slo.id} (objective ${num(slo.objective * 100)}% over ${slo.window}), with at least ${MIN_BAD_SAMPLES} bad samples in the ${short} window.`,
        slo_objective: `${num(slo.objective * 100)}%`,
        slo_window: String(slo.window),
        ...(RUNBOOK[sli.id] ? { runbook: RUNBOOK[sli.id] } : {}),
      },
    });
    burnCount++;
  }
  groups.push({ name: `${svc}_${slo.id}_burn`, interval: '30s', rules });
}

// ----------------------------------------------------------------- forecast alerts (deviation 3)
const forecasts = [];
for (const f of pack.spec.policy.forecasts || []) {
  const slo = slos[f.slo];
  if (!slo) throw new Error(`forecast references unknown SLO ${f.slo}`);
  const burn = `${svc}:errorbudget:burn_1h{slo="${slo.id}"}`;
  // Deviation 5: the projection horizon is capped at the regression window (1 d). Extrapolating
  // a 1 d regression 7 d out multiplies the slope by 7 and turned every post-incident tail into
  // a "breach within 7 d"; the annotation states the horizon actually evaluated.
  const declared = f.horizon || '7d';
  const horizon = Math.min(durationSeconds(declared), 86400);
  const action = f.on_projected_breach || 'open_ticket';
  forecasts.push({
    alert: `${slo.id}_forecast_breach`,
    expr: `predict_linear(${burn}[1d], ${horizon}) > 1 and min_over_time(${burn}[2h]) > 1`,
    for: '15m',
    // severity follows the pack's on_projected_breach: routing is by severity only, so a
    // page_oncall forecast emitted as SEV3 would land in the team channel, never on a pager.
    labels: { severity: FORECAST_SEVERITY[action] || 'SEV3', pack: svc, slo: slo.id, sli: slo.sli, service: svc, kind: 'forecast' },
    annotations: {
      summary: `${slo.id} has burned faster than its budget for 2h and the trend projects a breach`,
      method: `linear on the 1h burn rate (pack declares ${f.method || 'linear'}; the lab implements linear only)`,
      horizon: horizon === durationSeconds(declared) ? String(declared) : `${horizon / 86400}d evaluated (pack declares ${declared}; capped at the 1d regression window, deviation 5)`,
      horizon_declared: String(declared),
      on_projected_breach: action,
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

if (process.argv.includes('--pack-snippet')) {
  for (const r of recording) {
    console.log(`      - name: ${r.record}`);
    console.log(`        expr: '${r.expr.replace(/'/g, "''")}'`);
    console.log(`        interval: 30s`);
    console.log(`        labels: { slo: ${r.labels.slo}, sli: ${r.labels.sli}, service: ${r.labels.service} }`);
  }
  process.exit(0);
}
const header = [
  `# GENERATED by tools/gen-burn-rules.mjs from ${PACK} (spec.policy) — do not edit.`,
  '# Multi-window burn-rate alerts (one per declared window), forecast alerts and the',
  '# error-budget recording rules. Names/labels follow Observogram\'s compiler; the generator',
  '# header lists the five PromQL deviations (bad/expected-sample ratios, short-window floor,',
  '# sustained-burn forecasts, lab for:, capped horizon + severity). Regenerate: npm run burn-rules',
  '',
];
writeFileSync(resolve(root, OUT), header.concat(['groups:'], emitSeq(groups, 2), ['']).join('\n'));
console.log(`${OUT}: ${recording.length} recording rules, ${burnCount} burn-rate alerts, ${forecasts.length} forecast alerts`);
