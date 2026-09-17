// Burn-rate policy → Prometheus rules, for any ObservabilityPack.
//
//   spec.policy.burn_rate_alerts  → one multi-window burn-rate alert per declared window
//   spec.policy.forecasts         → one forecast alert per entry
//   plus the error-budget recording rules the dashboards read
//   (<svc>:errorbudget:burn_5m / burn_1h per SLO, <svc>:<sli>:error_ratio_5m for threshold SLIs)
//
// Naming, labels, annotations and grouping follow compile.mjs (compilePrometheusRules): alert
// `<slo>_burn_<factor>x_<short>_<long>`, labels severity/slo/sli/service/burn_rate/window_short/
// window_long, group `<svc>_<slo>_burn`, forecast alert `<slo>_forecast_breach` with `kind: forecast`.
//
// Five deliberate deviations from that compiler's PromQL, each found by running the rules against
// a live queue manager (mq-observability-pack, docs/catalogue-evidence/ibmmq.md §8):
//   1. Error ratios count BAD events over the events that happened (rate-style SLIs on request or
//      probe counters: increase(total) - increase(good) over increase(total), floored at one event)
//      or BAD SAMPLES over the EXPECTED number of samples in the window (state-style and threshold
//      SLIs: window / scrape step), never rate() or avg_over_time() over whatever samples exist:
//      on a fresh TSDB those are since-start averages and every 6 h window fired after the first
//      fault of a session. Time with no samples counts as good; symptom alerts own "no data".
//      - state-style ratio SLIs (good = sum(<state> == bool 1)): bad = sum_over_time of (1 - state);
//        a filter comparison (`== 1` without bool) is rewritten to `== bool 1`, otherwise the
//        down series vanish from the leg instead of counting as bad.
//      - rate-style ratio SLIs (counters): bad = increase(total) - increase(good)
//      - threshold SLIs: bad = samples of the recorded SLI above its threshold (all upper bounds)
//   2. The short window additionally needs at least MIN_BAD_SAMPLES bad samples/events: with the
//      long leg loaded by an incident, one bad 10 s sample in 5 m (3.3 %) already exceeds a
//      14 × 0.1 % threshold and re-fired SEV1 for the rest of the hour.
//   3. Forecast alerts regress the recorded 1 h burn rate over 1 d and require it to have been
//      above 1× for 2 h; the compiler's predict_linear on the 5 m error ratio fired ~15 min after
//      every transient outage (measured: 28 min of "breach within 7 d" after a 2 min stop).
//   4. `for:` is either lab-tuned (30 s / 2 m / 5 m by short window, `lab: true`) or the compiler's
//      production defaults (2 m / 5 m / 10 m).
//   5. The forecast horizon is capped at the 1 d regression window (a 7 d extrapolation of a
//      1 d slope is 7× more sensitive); the annotation says which horizon was evaluated and the
//      severity follows on_projected_breach (page_oncall → SEV1, open_ticket → SEV2, else SEV3).

const strip = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const num = (x) => Number(x).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
const RANGE = /\[\s*\d+(?:\.\d+)?(?:ms|s|m|h|d|w)\s*\]/g;
const hasRange = (e) => /\[\s*\d+(?:\.\d+)?(?:ms|s|m|h|d|w)\s*\]/.test(e);
const UNITS = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
export function durationSeconds(d) {
  let total = 0, m; const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g;
  while ((m = re.exec(String(d ?? '')))) total += Number(m[1]) * UNITS[m[2]];
  if (!(total > 0)) throw new Error(`cannot parse duration ${JSON.stringify(d)}`);
  return total;
}
const FORECAST_SEVERITY = { page_oncall: 'SEV1', open_ticket: 'SEV2', post_warning: 'SEV3' };   // deviation 5

/** The scrape step a pack implies: the smallest scrape_interval of its prometheus receivers, else 30 s. */
export function packStepSeconds(pack) {
  const ivs = (pack.spec.pipelines?.receivers || []).flatMap(r => (r.scrape_configs || []).map(s => s.scrape_interval)).filter(Boolean);
  const secs = ivs.map(i => { try { return durationSeconds(i); } catch { return null; } }).filter(x => x);
  return secs.length ? Math.min(...secs) : 30;
}

/**
 * `== 1` → `== bool 1` (and the other comparison operators) unless already boolean. Label
 * matchers inside `{...}` are left alone: `{code!="5"}` is a selector, not a comparison.
 */
export function boolify(expr) {
  return String(expr).split(/(\{[^}]*\})/).map((seg, i) => (i % 2 ? seg : seg.replace(/(==|!=|<=|>=|<|>)(?!\s*bool\b)\s*/g, (m, op) => `${op} bool `))).join('');
}

/**
 * Compile a pack's policy. Options: step (seconds between samples; default from the pack),
 * lab (short `for:`), minBadSamples, runbooks ({ sliId: path }), packPath (for the header).
 * Returns { groups, recording, burnCount, forecasts, warnings }.
 */
export function compileBurnRules(pack, { step, lab = false, minBadSamples = 2, runbooks = {} } = {}) {
  const STEP_SEC = step || packStepSeconds(pack);
  const SUBQ = `${STEP_SEC}s`;
  const svc = pack.metadata.name;
  const slis = Object.fromEntries((pack.spec.slis || []).map(s => [s.id, s]));
  const slos = Object.fromEntries((pack.spec.slos || []).map(s => [s.id, s]));
  const warnings = [];
  const warn = (m) => { if (!warnings.includes(m)) warnings.push(m); };
  const expectedSamples = (w) => Math.round(durationSeconds(w) / STEP_SEC);

  function recordedSeries(sliId) {
    const r = (pack.spec.queries?.recording_rules || []).find(x => strip(x.expr) === `ref:slis.${sliId}`);
    return r ? r.name : null;
  }
  /** { bad, denom } for an SLO over window w; error ratio = bad / denom. */
  function legs(slo, w) {
    const sli = slis[slo.sli];
    if (!sli) throw new Error(`SLO ${slo.id}: unknown SLI ${slo.sli}`);
    const n = expectedSamples(w);
    if (sli.type === 'ratio') {
      const good = strip(sli.good), total = strip(sli.total);
      if (hasRange(good)) {
        // rate-style counters: bad events = increase(total) - increase(good), over the events that happened
        const toInc = (e) => e.replace(/\brate\(/g, 'increase(').replace(RANGE, `[${w}]`);
        return { bad: `((${toInc(total)}) - (${toInc(good)}))`, denom: `clamp_min((${toInc(total)}), 1)` };
      }
      // state-style: good = sum(<state> == bool 1) → bad samples = sum over series of (1 - state)
      const m = /^sum\(([\s\S]*)\)$/.exec(good);
      if (!m) throw new Error(`SLI ${sli.id}: cannot derive bad samples from good=${good}`);
      let state = m[1].trim();
      const b = boolify(state);
      if (b !== state) { warn(`SLI ${sli.id}: comparison in good leg rewritten to bool form (${state} → ${b})`); state = b; }
      return { bad: `sum(sum_over_time((1 - (${state}))[${w}:${SUBQ}]))`, denom: `((${total}) * ${n})` };
    }
    if (sli.type === 'threshold') {
      if (!(Number(sli.threshold) >= 0)) throw new Error(`threshold SLI ${sli.id}: threshold must be a non-negative upper bound`);
      let series = recordedSeries(sli.id);
      if (!series) { warn(`threshold SLI ${sli.id}: no recording rule with expr ref:slis.${sli.id}; using the query inline`); series = `(${strip(sli.query || sli.expression)})`; }
      return { bad: `sum_over_time((max(${series}) > bool ${num(sli.threshold)})[${w}:${SUBQ}])`, denom: String(n) };
    }
    throw new Error(`SLI ${sli.id}: unsupported type ${sli.type}`);
  }
  const errorRatioAt = (slo, w) => { const { bad, denom } = legs(slo, w); return `(${bad} / ${denom})`; };
  const badCountAt = (slo, w) => legs(slo, w).bad;
  const forFor = (short) => { const s = durationSeconds(short); return lab ? (s <= 300 ? '30s' : s <= 1800 ? '2m' : '5m') : (s <= 300 ? '2m' : s <= 1800 ? '5m' : '10m'); };

  // ----------------------------------------------------------------- recording
  const recording = [];
  for (const slo of pack.spec.slos || []) {
    const sli = slis[slo.sli];
    if (sli?.type === 'threshold') recording.push({ record: `${svc}:${sli.id}:error_ratio_5m`, expr: errorRatioAt(slo, '5m'), labels: { slo: slo.id, sli: sli.id, service: svc } });
  }
  for (const slo of pack.spec.slos || []) {
    const budget = num(1 - slo.objective);
    for (const w of ['5m', '1h']) recording.push({ record: `${svc}:errorbudget:burn_${w}`, expr: `${errorRatioAt(slo, w)} / ${budget}`, labels: { slo: slo.id, sli: slo.sli, service: svc } });
  }

  // ----------------------------------------------------------------- burn-rate alerts
  const groups = [{ name: `${svc}.errorbudget`, interval: '30s', rules: recording }];
  let burnCount = 0;
  for (const ba of pack.spec.policy?.burn_rate_alerts || []) {
    const slo = slos[ba.slo];
    if (!slo) throw new Error(`policy references unknown SLO ${ba.slo}`);
    const sli = slis[slo.sli];
    const budget = 1 - slo.objective;
    const rules = [];
    for (const w of ba.windows || []) {
      const factor = w.factor, short = w.short, long = w.long;
      const threshold = num(factor * budget);
      const name = `${slo.id}_burn_${factor}x_${short}_${long}`.replace(/[^a-zA-Z0-9_]/g, '_');
      rules.push({
        alert: name,
        expr: ['(', `  ${errorRatioAt(slo, short)} > ${threshold}`, ') and (', `  ${errorRatioAt(slo, long)} > ${threshold}`, ') and (', `  ${badCountAt(slo, short)} >= ${minBadSamples}`, ')'].join('\n'),
        for: forFor(short),
        labels: { severity: w.severity, pack: svc, slo: slo.id, sli: sli.id, service: svc, burn_rate: String(factor), window_short: short, window_long: long },
        annotations: {
          summary: `Burn rate ${factor}x on ${slo.id}`,
          description: `Both the ${short} and ${long} error ratios exceed ${factor}x of the ${num(budget * 100)}% error budget for ${slo.id} (objective ${num(slo.objective * 100)}% over ${slo.window}), with at least ${minBadSamples} bad samples in the ${short} window.`,
          slo_objective: `${num(slo.objective * 100)}%`,
          slo_window: String(slo.window),
          ...(runbooks[sli.id] ? { runbook: runbooks[sli.id] } : {}),
        },
      });
      burnCount++;
    }
    groups.push({ name: `${svc}_${slo.id}_burn`, interval: '30s', rules });
  }

  // ----------------------------------------------------------------- forecast alerts (deviation 3)
  const forecasts = [];
  for (const f of pack.spec.policy?.forecasts || []) {
    const slo = slos[f.slo];
    if (!slo) throw new Error(`forecast references unknown SLO ${f.slo}`);
    const burn = `${svc}:errorbudget:burn_1h{slo="${slo.id}"}`;
    const declared = f.horizon || '7d';
    const horizon = Math.min(durationSeconds(declared), 86400);
    const action = f.on_projected_breach || 'open_ticket';
    forecasts.push({
      alert: `${slo.id}_forecast_breach`,
      expr: `predict_linear(${burn}[1d], ${horizon}) > 1 and min_over_time(${burn}[2h]) > 1`,
      for: '15m',
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
  return { groups, recording, burnCount, forecasts, warnings, step: STEP_SEC };
}

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
export function toYaml(groups, headerLines = []) {
  return headerLines.concat(['groups:'], emitSeq(groups, 2), ['']).join('\n');
}
/** The generated recording rules as a pack `spec.queries.recording_rules` snippet. */
export function packSnippet(recording) {
  const out = [];
  for (const r of recording) {
    out.push(`      - name: ${r.record}`);
    out.push(`        expr: '${r.expr.replace(/'/g, "''")}'`);
    out.push('        interval: 30s');
    out.push(`        labels: { slo: ${r.labels.slo}, sli: ${r.labels.sli}, service: ${r.labels.service} }`);
  }
  return out.join('\n');
}
