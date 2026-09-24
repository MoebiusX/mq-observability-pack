// Burn-rate policy → Prometheus rules, for any ObservabilityPack.
//
//   spec.policy.burn_rate_alerts  → one multi-window burn-rate alert per declared window
//   spec.policy.forecasts         → one forecast alert per entry
//   plus the error-budget recording rules the dashboards read
//   (<svc>:errorbudget:burn_5m / burn_1h per SLO, <svc>:<sli>:error_ratio_5m for threshold SLIs)
//
// This module is the single source of the policy PromQL. It exports pure per-SLI / per-SLO
// primitives (sliLegs, burnAlertExpr, errorBudgetRecordingRules, forecastExpr, forecastHorizon,
// forecastSeverity, forFor, ...) that take objects plus a naming/step context and never throw on
// an SLI's shape, and two consumers built on them: compileBurnRules (the generator entry used by
// tools/gen-burn-rules.mjs) and, in tools/lib/compile.mjs, compilePrometheusRules and its per-SLO
// and Grafana-managed builders. Both emit the same expressions for the same SLI, up to the name
// of the recorded series a threshold SLI is read from: the generator reads the pack's own
// `ref:slis.<id>` recording rule at that rule's interval, the compiler its `<svc>:<sli>:value_5m`
// at the 30 s recording interval. Either way each recorded point is counted once.
//
// Naming, labels, annotations and grouping follow compile.mjs (compilePrometheusRules): alert
// `<slo>_burn_<factor>x_<short>_<long>`, labels severity/slo/sli/service/burn_rate/window_short/
// window_long, group `<svc>_<slo>_burn`, forecast alert `<slo>_forecast_breach` with `kind: forecast`.
//
// Five deliberate deviations from the compiler's original naive PromQL, each found by running
// the rules against a live queue manager (mq-observability-pack, docs/catalogue-evidence/ibmmq.md
// §8); since compile.mjs calls this module, they now apply to every compiled artefact too:
//   1. Error ratios count BAD events over the events that happened (rate-style SLIs on request or
//      probe counters: increase(total) - increase(good) over increase(total), floored at one event;
//      `or increase(total)` fills the difference where the good SELECTOR matches no series at
//      all, because a vector subtraction with no right-hand match is empty and a 100 % outage
//      would otherwise be the one case that cannot alert. The fill is selector-only: a good leg
//      derived by arithmetic (`sum(rate(all)) - sum(rate(err))`) is empty whenever the subtracted
//      counter has never been exposed, and the fill would read that healthy service as a 100 %
//      outage, so such a leg gets no fill and a warning asking for `or vector(0)` in the pack;
//      the same holds when the two legs aggregate to different label sets, `sum by (route)` over
//      `sum`: the difference matches nothing and the fill would page a healthy service, warned)
//      or BAD SAMPLES over the EXPECTED number of samples in the window (state-style and threshold
//      SLIs: window / scrape step), never rate() or avg_over_time() over whatever samples exist:
//      on a fresh TSDB those are since-start averages and every 6 h window fired after the first
//      fault of a session. Time with no samples counts as good; symptom alerts own "no data".
//      - state-style ratio SLIs (good = sum(<state> == bool 1), or count(<state> == 1) read as
//        that sum): bad = sum_over_time of (1 - state); a filter comparison (`== 1` without bool)
//        is rewritten to `== bool 1`, otherwise the down series vanish from the leg instead of
//        counting as bad. A bare gauge over a scalar total (`up{job="x"}` / 1) is a state series.
//      - rate-style ratio SLIs (counters): bad = increase(total) - increase(good). A bare selector
//        is counted with increase() only when it can be a raw counter: a recording-rule name
//        (`svc:req:good_rate_5m`) is a rate or a gauge and gets no policy rules (warned); a name
//        without a counter suffix is warned about.
//      - threshold SLIs: bad = samples of the recorded SLI on the BAD side of its bound, sampled at
//        the recorded series' own interval. The side is the SLI's `good_when` (spec 1.3, read
//        through good-when.mjs goodWhen(): absent means below): `below` — a ceiling, the only
//        meaning a 1.2 pack could express — counts samples ABOVE the bound (`> bool t`); `above` —
//        a floor: replicas, consumers, free capacity — counts samples UNDER it (`< bool t`). The
//        bound itself is good either way. A ratio-valued query or a ratio unit with no direction
//        declared is warned about as a probable floor, never inverted on a guess.
//      No naive form survives for any shape: a ratio with no event or sample count (a scalar good
//      over a rate, avg() over count(), an opaque `total: "1"`) gets NO policy rules and a
//      warning, never an unfloored `1 - good / total` alert; and compile.mjs no longer records a
//      `1 - <sli>:ratio_5m` error ratio for such an SLI (its dashboards show no series, which is
//      honest, rather than a ratio that is empty in a 100 % outage).
//   2. The short window additionally needs at least MIN_BAD_SAMPLES bad samples/events: with the
//      long leg loaded by an incident, one bad 10 s sample in 5 m (3.3 %) already exceeds a
//      14 × 0.1 % threshold and re-fired SEV1 for the rest of the hour. The floor counts SAMPLES,
//      so a state-style leg is sampled at the scrape interval of the job it selects (`job="..."`
//      looked up in the pack's scrape_configs, sliStepSeconds) and only falls back to the pack's
//      smallest interval: a 60 s job read every 15 s counts each sample four times and a single
//      bad sample would satisfy the floor. An explicit `step` option overrides both.
//   3. Forecast alerts regress the recorded 1 h burn rate over 1 d and require it to have been
//      above 1× for 2 h; the compiler's predict_linear on the 5 m error ratio fired ~15 min after
//      every transient outage (measured: 28 min of "breach within 7 d" after a 2 min stop).
//   4. `for:` is either lab-tuned (30 s / 2 m / 5 m by short window, `lab: true`) or the compiler's
//      production defaults (2 m / 5 m / 10 m).
//   5. The forecast horizon is capped at the 1 d regression window (a 7 d extrapolation of a
//      1 d slope is 7× more sensitive); the annotation says which horizon was evaluated and the
//      severity follows on_projected_breach (page_oncall → SEV1, open_ticket → SEV2, else SEV3).
//
// Plain ESM, browser-safe (the studio imports compile.mjs): only ./slug.mjs and ./good-when.mjs
// (both zero-import leaves) are imported.

import { fileSlug, metricPrefix } from './slug.mjs';
import { badComparator } from './good-when.mjs';

// Whitespace is collapsed OUTSIDE string literals only: a label value such as `route="/a  b"`
// (or one carrying a newline) is part of the selector and must survive byte for byte,
// otherwise the burn legs select different series than the SLI's own recording rule.
const STRING_LITERAL = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/;
const strip = (s) => String(s ?? '').split(STRING_LITERAL).map((seg, i) => (i % 2 ? seg : seg.replace(/\s+/g, ' '))).join('').trim();
const num = (x) => Number(x).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
// A range selector `[5m]` or a subquery `[5m:1m]` / `[5m:]` (both make an expression a range
// expression); rerange() swaps the range for `w` and keeps a subquery's resolution, so
// `rate(x[5m:1m])` over 1 h becomes `increase(x[1h:1m])`, never the invalid `x[1h]` of a subquery
// over a non-selector.
const DUR = '\\d+(?:\\.\\d+)?(?:ms|s|m|h|d|w)';
const RANGE = new RegExp(`\\[\\s*${DUR}\\s*(:\\s*(?:${DUR})?\\s*)?\\]`, 'g');
// Ranges are looked for and rewritten OUTSIDE string literals only, like strip(): a label value
// `path="[5m]"` is not a range, and rewriting it would make the 1 h leg select another series.
const outside = (e, f) => String(e).split(STRING_LITERAL).map((s, i) => (i % 2 ? s : f(s))).join('');
const codeOnly = (e) => String(e).split(STRING_LITERAL).filter((_, i) => i % 2 === 0).join(' ');
const RANGE_ONE = new RegExp(`\\[\\s*${DUR}\\s*(?::\\s*(?:${DUR})?\\s*)?\\]`);
const hasRange = (e) => RANGE_ONE.test(codeOnly(e));
const rerange = (e, w) => outside(e, (s) => s.replace(RANGE, (m, res) => `[${w}${res ? `:${res.slice(1).trim()}` : ''}]`));
const SCALAR = /^\d+(?:\.\d+)?$/;
const SELECTOR = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})?$/;
// A bare selector's metric name, and the suffixes a raw Prometheus counter carries. A name with
// `:` is a recording rule — in every pack of this repo a per-second rate or a gauge — and
// increase() of a rate sums every upward move into a meaningless bad count.
const metricName = (sel) => sel.replace(/\{[\s\S]*$/, '');
const COUNTER_SUFFIX = /_(total|count|sum|bucket)$/;
// A good leg derived by arithmetic (`sum(rate(all)) - sum(rate(err))`, `a + b`, `x unless y`):
// binary vector operators are looked for outside string literals, label matchers and ranges,
// with numeric literals blanked first so `1e-3` is not read as a subtraction. `-`/`+`/`*`
// count only in binary position (after `)`, `]`, `}`, a name or a number).
function goodIsDerived(expr) {
  const bare = String(expr).split(STRING_LITERAL).map((seg, i) => (i % 2 ? '""' : seg)).join('')
    .replace(/\{[^}]*\}/g, '{}').replace(/\[[^\]]*\]/g, '[]')
    .replace(/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, '0');
  return /\b(and|or|unless)\b/.test(bare) || /[)\]}\w]\s*[-+*]/.test(bare);
}
// A derived good whose subtracted leg already carries the fill the warning below asks for
// (`sum(rate(all)) - (sum(rate(err)) or vector(0))`): the difference is defined whenever total
// is, and advising the guard again would be wrong advice for the pack that took it (the
// grafana reference pack's alerting SLI, 2026-09-22). Looked for outside string literals.
function derivationGuarded(expr) {
  const bare = String(expr).split(STRING_LITERAL).map((seg, i) => (i % 2 ? '""' : seg)).join('');
  return /\bor\s+vector\(\s*0\s*\)/.test(bare);
}
// Legs no event count can be derived from: a per-second rate of the last two samples, or a
// derivative / delta of a gauge — increase() has no meaning for them.
const UNCOUNTABLE = /\b(irate|deriv|delta|idelta)\(/;
// The spec's Duration units (the vendored schema's Duration pattern: ns|us|ms|s|m|h|d|w|mo|y).
const UNITS = { ns: 1e-9, us: 1e-6, ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, mo: 2628000, y: 31536000 };

/** Prometheus metric/rule names accept only [a-zA-Z0-9_:]: an SLI id like `latência` embedded raw
 *  into a recording-rule name is a promtool parse error. Label VALUES keep the raw id. */
export const metricSafe = (id) => String(id ?? '').replace(/[^a-zA-Z0-9_]/g, '_');
/** The metric-name prefix of a pack: its file slug with `_` for `-` (`payment-service` →
 *  `payment_service`; a raw `payment-service:errorbudget:burn_1h` is rejected by promtool 2.55 and
 *  parsed as `payment - service:...` by 3.14). Equals compile.mjs's serviceSlug for every input. */
// metricPrefix lives in slug.mjs (a leaf the site core can vendor alone); re-exported here for every existing importer.
export { metricPrefix };

export const MIN_BAD_SAMPLES = 2;                       // deviation 2
export const RECORD_WINDOWS = ['5m', '1h'];
export const REGRESSION_WINDOW = '1d';
export const REGRESSION_SECONDS = 86400;                // [1d] regression and the horizon cap (deviation 5)
export const SUSTAIN_WINDOW = '2h';
export const FORECAST_SEVERITY = { page_oncall: 'SEV1', open_ticket: 'SEV2', post_warning: 'SEV3' };

/** Seconds in a spec Duration (`5m`, `1h30m`, `1mo`, `1y`), or null when nothing parses. The
 *  alternation lists `ms`/`mo` before `m` so `1mo` is a month, not a minute followed by junk. */
export function durationSeconds(d) {
  let total = 0, m; const re = /(\d+(?:\.\d+)?)(ms|mo|ns|us|s|m|h|d|w|y)/g;
  while ((m = re.exec(String(d ?? '')))) total += Number(m[1]) * UNITS[m[2]];
  return total > 0 ? total : null;
}

/** The scrape step a pack implies: the smallest scrape_interval of its prometheus receivers, else 30 s. */
export function packStepSeconds(pack) {
  const ivs = (pack?.spec?.pipelines?.receivers || []).flatMap(r => (r.scrape_configs || []).map(s => s.scrape_interval)).filter(Boolean);
  const secs = ivs.map(durationSeconds).filter(x => x);
  return secs.length ? Math.min(...secs) : 30;
}

/**
 * The scrape step of the job(s) an SLI's expressions select: every `job="<name>"` matcher is
 * looked up in the pack's prometheus receivers' `scrape_configs[].job_name`, and that job's
 * `scrape_interval` is the step (the smallest when the legs name several). `fallback` (the pack
 * minimum) applies when no matcher names a known job — warned about when the pack's jobs are
 * scraped at more than one interval, because reading a 60 s job at the pack's 15 s minimum
 * counts each sample four times and one bad sample satisfies the two-sample floor (deviation 2).
 */
export function sliStepSeconds(pack, exprs, fallback, warn = () => {}, id = '?') {
  const configs = (pack?.spec?.pipelines?.receivers || []).flatMap(r => r.scrape_configs || []);
  const byJob = new Map(configs.filter(c => c.job_name && durationSeconds(c.scrape_interval)).map(c => [String(c.job_name), durationSeconds(c.scrape_interval)]));
  const jobs = new Set();
  for (const e of [].concat(exprs)) for (const m of String(e ?? '').matchAll(/\bjob\s*=\s*"((?:[^"\\]|\\.)*)"/g)) jobs.add(m[1]);
  const found = [...jobs].filter(j => byJob.has(j)).map(j => byJob.get(j));
  if (found.length) return Math.min(...found);
  const distinct = [...new Set(byJob.values())];
  if (distinct.length > 1) {
    warn(`SLI ${id}: no job="..." matcher names one of the pack's scrape jobs (${[...byJob.keys()].join(', ')}), which are scraped at different intervals (${distinct.map(s => `${s}s`).join(', ')}); sampling at ${fallback}s`);
  }
  return fallback;
}

/**
 * `== 1` → `== bool 1` (and the other comparison operators) unless already boolean. Label
 * matchers inside `{...}` and string literals are left alone: `{code!="5"}` is a selector, not
 * a comparison, and `label_replace(a, "x", "==", ...)` carries no operator. The operator token
 * is matched whole: `(?![=~])` stops `>=` / `<=` from backtracking to `>` / `<` when the
 * `bool` lookahead fails, which produced `> bool = bool 1` (a parse error). Idempotent.
 */
const COMPARISON = /(==|!=|<=|>=|<|>)(?![=~])(?!\s*bool\b)\s*/g;
export function boolify(expr) {
  const outsideStrings = (seg) => seg.split(STRING_LITERAL).map((s, i) => (i % 2 ? s : s.replace(COMPARISON, (m, op) => `${op} bool `))).join('');
  return String(expr).split(/(\{[^}]*\})/).map((seg, i) => (i % 2 ? seg : outsideStrings(seg))).join('');
}

/** Samples a window holds at `step` seconds between samples (0 when w is not a duration). */
export const expectedSamples = (w, step) => Math.round((durationSeconds(w) || 0) / step);

/** `for:` of a burn alert from its short window (deviation 4); an unparseable window reads as the shortest. */
export function forFor(short, { lab = false } = {}) {
  const s = durationSeconds(short) || 0;
  return lab ? (s <= 300 ? '30s' : s <= 1800 ? '2m' : '5m') : (s <= 300 ? '2m' : s <= 1800 ? '5m' : '10m');
}

/** The forecast horizon actually evaluated: the declared one (7d when it is not a duration),
 *  capped at the regression window. `1mo` and `1y` are spec durations and cap like any other. */
export function forecastHorizon(declared = '7d') {
  let d = durationSeconds(declared);
  if (d == null) { declared = '7d'; d = durationSeconds(declared); }
  const seconds = Math.min(d, REGRESSION_SECONDS);
  return { declared: String(declared), seconds, capped: seconds < d };
}

export const forecastSeverity = (action) => FORECAST_SEVERITY[action || 'open_ticket'] || 'SEV3';

/** Deviation 3: the 1 h burn regressed over 1 d must project past 1× and have been above 1× for 2 h. */
export const forecastExpr = (burnSeries, horizonSeconds) =>
  `predict_linear(${burnSeries}[${REGRESSION_WINDOW}], ${horizonSeconds}) > 1 and min_over_time(${burnSeries}[${SUSTAIN_WINDOW}]) > 1`;

// Parentheses balance outside string literals (a `)` inside a label value is text).
const balanced = (s) => { let d = 0; for (const c of codeOnly(s)) { if (c === '(') d++; else if (c === ')' && --d < 0) return false; } return d === 0; };
// `a / b` → ['a', 'b'] when exactly one `/` sits at the top level (outside parentheses, range
// selectors, label matchers and string literals); an enclosing pair of parentheses around a
// leg is dropped. Anything else (no `/`, several, `(a / b) / c`) is null.
function splitTopLevelDivision(expr) {
  const s = String(expr);
  const at = [];
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '/' && depth === 0) at.push(i);
  }
  if (at.length !== 1) return null;
  const legs = [s.slice(0, at[0]).trim(), s.slice(at[0] + 1).trim()];
  return legs.every(l => l !== '' && balanced(l)) ? legs.map(unwrap) : null;
}
// `(x)` → `x` while the outer parentheses enclose the whole expression.
function unwrap(e) {
  while (e.startsWith('(') && e.endsWith(')') && balanced(e.slice(1, -1))) e = e.slice(1, -1).trim();
  return e;
}
// The outermost aggregation of a leg — `<op> by (a) (...)`, `<op>(...) by (a)`, `<op>(...)` —
// as { op, modifier: 'by' | 'without' | '', labels: sorted [] }; null when the leg is not one
// aggregation call (a bare range expression, a binary expression). String literals are blanked
// so a `)` inside a label value cannot end the call.
const AGG_OPS = '(sum|min|max|avg|group|stddev|stdvar|count|count_values|bottomk|topk|quantile|limitk|limit_ratio)';
const AGG_MOD_FIRST = new RegExp(`^${AGG_OPS}\\s+(by|without)\\s*\\(([^)]*)\\)\\s*\\(([\\s\\S]*)\\)$`);
const AGG_MOD_LAST = new RegExp(`^${AGG_OPS}\\s*\\(([\\s\\S]*)\\)\\s*(by|without)\\s*\\(([^)]*)\\)$`);
const AGG_PLAIN = new RegExp(`^${AGG_OPS}\\s*\\(([\\s\\S]*)\\)$`);
const groupingOf = (modifier, labels) => ({ modifier, labels: labels.split(',').map(l => l.trim()).filter(Boolean).sort() });
function aggregation(expr) {
  const e = String(expr).split(STRING_LITERAL).map((s, i) => (i % 2 ? '""' : s)).join('');
  let m = AGG_MOD_FIRST.exec(e);
  if (m && balanced(m[4])) return { op: m[1], ...groupingOf(m[2], m[3]) };
  m = AGG_MOD_LAST.exec(e);
  if (m && balanced(m[2])) return { op: m[1], ...groupingOf(m[3], m[4]) };
  m = AGG_PLAIN.exec(e);
  if (m && balanced(m[2])) return { op: m[1], modifier: '', labels: [] };
  return null;
}
const describeGrouping = (g) => (g.modifier ? `groups ${g.modifier} (${g.labels.join(', ')})` : 'does not group');
// The good and total legs of a ratio must aggregate to the same label set, or `total - good`
// matches nothing: warns and returns true on a mismatch. Two legs that are not aggregations at
// all (per-series rates) are read as compatible; one aggregated and one not is not.
function groupingMismatch(id, gGroup, tGroup, warn) {
  if (!gGroup && !tGroup) return false;
  if (!gGroup || !tGroup) {
    warn(`SLI ${id}: ${gGroup ? 'good' : 'total'} is aggregated (${(gGroup || tGroup).op}) but ${gGroup ? 'total' : 'good'} is not; the two legs will not match`);
    return true;
  }
  if (gGroup.modifier === tGroup.modifier && gGroup.labels.join(',') === tGroup.labels.join(',')) return false;
  const [g, t] = [describeGrouping(gGroup), describeGrouping(tGroup)];
  warn(`SLI ${id}: good ${g} but total ${t === 'does not group' ? 'does not' : t}; the two legs will not match`);
  return true;
}
// A state-style good leg: `sum(<state>)`, `sum by (labels) (<state>)`, `sum(<state>) by (labels)`
// (`without` too), or the same with count() around a comparison (`count(up == 1)`: the count of
// matching series, which the bool form counts as sum(<state> == bool 1) — a count() without a
// comparison is not a state leg). Returns { op, state, grouping } — null otherwise.
function stateLeg(good) {
  const agg = aggregation(good);
  if (!agg || (agg.op !== 'sum' && agg.op !== 'count')) return null;
  // the emitted grouping keeps the pack's own label order; `grouping` (sorted) is for comparison
  let m = AGG_MOD_FIRST.exec(good), state = null, text = '';
  if (m && balanced(m[4])) { state = m[4].trim(); text = `${m[2]} (${m[3].split(',').map(l => l.trim()).join(', ')})`; }
  else if ((m = AGG_MOD_LAST.exec(good)) && balanced(m[2])) { state = m[2].trim(); text = `${m[3]} (${m[4].split(',').map(l => l.trim()).join(', ')})`; }
  else if ((m = AGG_PLAIN.exec(good)) && balanced(m[2])) state = m[2].trim();
  if (state == null) return null;
  if (agg.op === 'count' && !/ bool /.test(boolify(state))) return null;
  return { op: agg.op, state, grouping: agg, groupingText: text };
}
// A threshold read as a ceiling is wrong for a ratio-valued query whose objective is a floor (probe
// success, `1 - error_ratio`). Spec 1.3 lets the pack say so (`good_when: above`); while it says
// nothing, the guess is named — and only then: a declared direction, either way, is the author's.
const RATIO_UNITS = new Set(['ratio', 'percent', 'percentunit']);
const looksLikeRatio = (q) => { const bare = q.replace(/\{[^}]*\}/g, ''); return /(?:^|[(\s])1\s*-\s/.test(bare) || bare.includes('/'); };

/**
 * Error-ratio legs of one SLI over window w. Never throws: an SLI shape or a window it cannot
 * express is warned about and null. ctx: { step, series, seriesStep, warn }
 *   step        seconds between raw samples → `[w:<step>s]` subqueries and expectedSamples for
 *               state-style legs
 *   series      threshold SLIs: the recorded series to read (e.g. 'payment_service:api_latency_p99:value_5m');
 *               absent → the SLI query is inlined `(${strip(query||expression)})` and warn() is called
 *   seriesStep  threshold SLIs: seconds between samples of `series` (default step)
 *   warn        (msg) => void, default no-op
 * Returns { kind, bad, denom, ratio } or null. ratio === `(${bad} / ${denom})` whenever bad is non-null.
 *   pack        optional: the pack, for the per-job sample step of state-style legs and inlined
 *               threshold queries (sliStepSeconds; `step` is then the fallback). Absent → `step`.
 * Every kind carries an event or sample count (`bad`), so the two-bad-samples floor always
 * applies: no naive `1 - good / total` form survives for any shape (a shape without a count
 * gets no policy rules and a warning, never an unfloored alert).
 * Kinds, tested in this order:
 *   scalar total    ratio SLI whose total is a scalar literal (live-drafted `total: "1"` when good is
 *                   already a complete ratio): a good that splits on one top-level `/`
 *                   (`sum(rate(ok[5m])) / sum(rate(all[5m]))`, `a:good_5m / a:total_5m`) is read on
 *                   its two legs as any other ratio; a bare gauge good (`up{job="x"}` over 1) is a
 *                   0/1 state series per series ('state', warned); anything else has no count: null
 *   'events'        ratio SLI on counters (good AND total carry a range, a subquery `[5m:1m]` counts
 *                   as one; a bare selector next to a range expression is wrapped in
 *                   sum(increase(sel[w])) first): increase(total) - increase(good) over
 *                   increase(total), the difference falling back to increase(total) when a good
 *                   SELECTOR matches nothing — never when good is derived by arithmetic (warned)
 *                   nor when the two legs aggregate to different label sets (`sum by (route)` vs
 *                   `sum`: the difference matches nothing and the fill would read a healthy
 *                   service as a 100 % outage; warned, no fill)
 *   'selector'      ratio SLI whose legs are both bare selectors: wrapped in sum(increase(sel[w]))
 *                   first. A bare selector is read as a raw counter: a name not ending in
 *                   _total/_count/_sum/_bucket is warned about, a recording-rule name (`:`) is a
 *                   rate or a gauge that cannot be counted — null, warned
 *   'state'         ratio SLI with good = sum(<state>), sum by (l) (<state>), sum(<state>) by (l) or
 *                   count(<state> <cmp> n) (read as sum(<state> <cmp> bool n), warned), and no range
 *                   on either leg: bad = sum_over_time(1 - state) over the expected samples, the
 *                   grouping carried (comparisons rewritten to bool form, warned), sampled at the
 *                   step of the job the legs select
 *   'threshold'     threshold SLI with a finite threshold: bad = recorded samples on the bad side of it —
 *                   above it for good_when below (the default), under it for good_when above (a floor)
 *   null            distribution / custom / unknown type, missing legs, a threshold that is not a number, legs
 *                   with irate()/deriv()/delta()/idelta() (no event count exists), a mixed
 *                   rate/gauge ratio, a scalar good, or an aggregation without a range (nothing
 *                   valid to emit)
 */
export function sliLegs(sli, w, ctx = {}) {
  const step = Number(ctx.step) || 30;
  const warn = typeof ctx.warn === 'function' ? ctx.warn : () => {};
  if (!sli || typeof sli !== 'object') return null;
  const id = sli.id ?? '?';
  if (durationSeconds(w) == null) { warn(`SLI ${id}: window ${JSON.stringify(w)} is not a duration; no policy rules`); return null; }
  if (sli.type === 'ratio') {
    if (sli.good == null || sli.total == null || strip(sli.good) === '' || strip(sli.total) === '') {
      warn(`SLI ${id}: ratio SLI without good/total; no policy rules`);
      return null;
    }
    let good = strip(sli.good), total = strip(sli.total);
    // The sample step of a state-style leg: the scrape interval of the job the legs select when
    // the pack is known (deviation 2: a 60 s job read at the pack's 15 s minimum counts every
    // sample four times), else ctx.step.
    const stepOf = (...exprs) => (ctx.pack ? sliStepSeconds(ctx.pack, exprs, step, warn, id) : step);
    if (SCALAR.test(total)) {
      // A live-drafted SLI (`total: "1"`, good = `<good> / <total>` from a ratio_* recording
      // rule) still carries its two legs: split good on its single top-level `/` and read them
      // as any ratio, so the floor and the empty-good fallback apply.
      const legs = splitTopLevelDivision(good);
      if (legs) return sliLegs({ ...sli, good: legs[0], total: legs[1] }, w, ctx);
      // A bare series over 1 is a 0/1 gauge (`up{job="x"}`): bad = samples at 0, per series.
      if (SELECTOR.test(good)) {
        const s = stepOf(good);
        warn(`SLI ${id}: total is the scalar ${total} and good is the bare series ${metricName(good)}; read as a 0/1 state gauge per series, sampled every ${s}s`);
        const bad = `sum_over_time((1 - (${good}))[${w}:${s}s])`, denom = String(expectedSamples(w, s));
        return { kind: 'state', bad, denom, ratio: `(${bad} / ${denom})` };
      }
      warn(`SLI ${id}: total is the scalar ${total} and good (${good}) is neither two legs nor a bare state series; no event or sample count, no policy rules`);
      return null;
    }
    if (UNCOUNTABLE.test(good) || UNCOUNTABLE.test(total)) {
      warn(`SLI ${id}: irate()/deriv()/delta()/idelta() legs have no event count; no policy rules`);
      return null;
    }
    // A bare selector is a counter to count: wrapped in sum(increase(sel[w])) when the other leg
    // is bare too ('selector') or already a range expression (a countable mixed shape, read as
    // 'events' — the naive `1 - sum(rate(sel)) / total` used to survive for it). Only a raw
    // counter can be counted: a recording rule (`:` in the name) is a rate or a gauge — null.
    let kind = 'events';
    const bareGood = !hasRange(good) && SELECTOR.test(good), bareTotal = !hasRange(total) && SELECTOR.test(total);
    if (bareGood && bareTotal) kind = 'selector';
    const wrapGood = bareGood && (bareTotal || hasRange(total)), wrapTotal = bareTotal && (bareGood || hasRange(good));
    for (const sel of [wrapGood ? good : null, wrapTotal ? total : null].filter(Boolean)) {
      const name = metricName(sel);
      if (name.includes(':')) {
        warn(`SLI ${id}: ${name} is a recording rule (a rate or a gauge), which increase() cannot count; point the SLI at the counter; no policy rules`);
        return null;
      }
      // (window-independent wording: the compiler de-duplicates warnings by message, one per leg)
      if (!COUNTER_SUFFIX.test(name)) warn(`SLI ${id}: ${name} is read as a raw counter (sum(increase(${name}[w]))); a recorded rate cannot be counted, point the SLI at the counter`);
    }
    if (wrapGood) good = `sum(increase(${good}[${w}]))`;
    if (wrapTotal) total = `sum(increase(${total}[${w}]))`;
    if (hasRange(good) && hasRange(total)) {
      // rate-style counters: bad events = increase(total) - increase(good), over the events that happened
      // (`rate(` is rewritten OUTSIDE string literals only, like the range: a label value
      // `path="/rate(a)"` is text, and rewriting it would make the leg select nothing)
      const toInc = (e) => rerange(outside(e, (s) => s.replace(/\brate\(/g, 'increase(')), w);
      // `or total`: vector subtraction drops every element without a match on the right, so when
      // no series satisfies the good selector (a 100 % outage: every pod has only ever answered
      // 5xx, or a counter exposed per observed status) `total - good` is EMPTY, not total, and
      // the alert could not fire. `or` keeps the difference where it exists and fills the
      // total's own elements (same label set, including any `by (...)`) where it is empty; when
      // total is empty too nothing fires, which is the intended "no traffic is good".
      // Selector-only: a good derived by arithmetic (`sum(rate(all)) - sum(rate(err))`) is empty
      // whenever `err` has never been exposed, and the fill would page a healthy service as a
      // 100 % outage (measured with promtool test rules: all_total only, no err series, burn_5m
      // read 100× the budget). Such a leg gets no fill; the pack owns the `or vector(0)`.
      // Nor when the legs aggregate to different label sets (`sum by (route)` over `sum`): the
      // difference matches nothing, so the fill would be the whole total — a permanent 100 %
      // outage on a healthy service (measured: zero errors, burn_5m 100×, SEV1). Warned, no fill.
      const derived = goodIsDerived(good);
      if (derived && !derivationGuarded(good)) warn(`SLI ${id}: good is derived by arithmetic; a good leg matching nothing cannot be told from a 100 % outage, add "or vector(0)" to the subtracted leg in the pack`);
      const mismatch = !derived && groupingMismatch(id, aggregation(good), aggregation(total), warn);
      const diff = `((${toInc(total)}) - (${toInc(good)}))`;
      const bad = derived || mismatch ? diff : `(${diff} or (${toInc(total)}))`, denom = `clamp_min((${toInc(total)}), 1)`;
      return { kind, bad, denom, ratio: `(${bad} / ${denom})` };
    }
    // state-style: good = sum(<state> == bool 1) → bad samples = sum over series of (1 - state);
    // a `by (...)` / `without (...)` grouping on good is carried into the bad leg (per-instance
    // availability), and total must carry the same grouping for the legs to match.
    const st = !hasRange(good) && !hasRange(total) ? stateLeg(good) : null;
    if (st) {
      let state = st.state;
      const b = boolify(state);
      if (st.op === 'count') {
        warn(`SLI ${id}: count(${state}) read as sum(${b}): a filter comparison inside count() drops the failing series, the bool form counts them as bad`);
        state = b;
      } else if (b !== state) { warn(`SLI ${id}: comparison in good leg rewritten to bool form (${state} → ${b})`); state = b; }
      groupingMismatch(id, st.grouping, aggregation(total), warn);
      const s = stepOf(good, total);
      const agg = st.groupingText ? `sum ${st.groupingText} ` : 'sum';
      const bad = `${agg}(sum_over_time((1 - (${state}))[${w}:${s}s]))`, denom = `((${total}) * ${expectedSamples(w, s)})`;
      return { kind: 'state', bad, denom, ratio: `(${bad} / ${denom})` };
    }
    // Anything else (a scalar good over a rate, avg(...) over count(...), a binary expression
    // without a range) has no event or sample count; the former naive `1 - good / total` is not
    // emitted for it (no floor, no expected-sample denominator).
    warn(`SLI ${id}: ratio shape not recognised (good=${good}, total=${total}); no policy rules`);
    return null;
  }
  if (sli.type === 'threshold') {
    const t = Number(sli.threshold);
    if (!Number.isFinite(t)) {
      warn(`threshold SLI ${id}: threshold must be a finite number (got ${JSON.stringify(sli.threshold)}); no policy rules`);
      return null;
    }
    const s = Number(ctx.seriesStep) || step;
    const q = strip(sli.query || sli.expression);
    const unit = String(sli.unit ?? '').toLowerCase();
    // The guess is raised only while the pack declares no direction: `good_when: above` makes the
    // floor first-class and `good_when: below` states the ceiling on purpose (a ratio-valued
    // headroom read against 0.8 is one; measured on the MQ pack, where the guess was wrong).
    if (sli.good_when == null && (RATIO_UNITS.has(unit) || (t === 1 && looksLikeRatio(q)))) {
      warn(`threshold SLI ${id}: the policy reads threshold ${num(t)} as a ceiling (bad = samples above it); `
        + `${RATIO_UNITS.has(unit) ? `unit ${unit}` : 'a ratio-shaped query with threshold 1'} looks like a floor — declare good_when: above (or good_when: below to state the ceiling)`);
    }
    let series = ctx.series, sampled = s;
    if (!series) {
      if (!q) { warn(`threshold SLI ${id}: no query; no policy rules`); return null; }
      warn(`threshold SLI ${id}: no recording rule with expr ref:slis.${id}; using the query inline`);
      series = `(${q})`;
      // inlined: sampled at the step of the job the query selects (a recorded series has seriesStep)
      if (!ctx.seriesStep && ctx.pack) sampled = sliStepSeconds(ctx.pack, [q], step, warn, id);
    }
    // Strict on the bad side: the bound itself is good whichever way the SLI faces (badComparator).
    const bad = `sum_over_time((max(${series}) ${badComparator(sli)} bool ${num(t)})[${w}:${sampled}s])`, denom = String(expectedSamples(w, sampled));
    return { kind: 'threshold', bad, denom, ratio: `(${bad} / ${denom})` };
  }
  warn(`SLI ${id}: type ${sli.type ?? '(none)'} has no error-ratio form; no policy rules`);
  return null;
}
export const errorRatioAt = (sli, w, ctx) => sliLegs(sli, w, ctx)?.ratio ?? null;
export const badCountAt = (sli, w, ctx) => sliLegs(sli, w, ctx)?.bad ?? null;

/** Multi-window alert expression; null when sliLegs is null. `threshold` is the pre-formatted string. */
export function burnAlertExpr(sli, { short, long, threshold, step, pack, series, seriesStep, minBadSamples = MIN_BAD_SAMPLES, warn }) {
  const ctx = { step, pack, series, seriesStep, warn };
  const s = sliLegs(sli, short, ctx), l = sliLegs(sli, long, ctx);
  if (!s || !l) return null;
  return ['(', `  ${s.ratio} > ${threshold}`, ') and (', `  ${l.ratio} > ${threshold}`,
    ...(s.bad ? [') and (', `  ${s.bad} >= ${minBadSamples}`] : []), ')'].join('\n');
}

/** The 5 m error-ratio record of an SLI (`<prefix>:<sli>:error_ratio_5m`): the same bad-over-
 *  expected (state, threshold) or bad-over-happened (counter) ratio the burn legs use, over 5 m.
 *  It does not depend on any SLO, so it is one rule per SLI with labels { sli, service }; null
 *  when sliLegs is null. */
export function sliErrorRatioRule(sli, { prefix, step, pack, series, seriesStep, labels, warn }) {
  const expr = errorRatioAt(sli, RECORD_WINDOWS[0], { step, pack, series, seriesStep, warn });
  return expr ? { record: `${prefix}:${metricSafe(sli.id)}:error_ratio_${RECORD_WINDOWS[0]}`, expr, labels } : null;
}
/** sliErrorRatioRule restricted to threshold SLIs: what the generator (compileBurnRules) records,
 *  because a pack of the generator's lineage declares its ratio SLIs' error ratios itself. */
export function thresholdErrorRatioRule(sli, ctx) {
  return sli?.type === 'threshold' ? sliErrorRatioRule(sli, ctx) : null;
}

/** Error-budget recording rules of one SLO (`errorbudget:burn_5m`, `burn_1h`, labels
 *  { slo, sli, service }); [] when sliLegs is null or budget <= 0. */
export function errorBudgetRecordingRules(slo, sli, { prefix, step, pack, series, seriesStep, labels, warn }) {
  const budget = 1 - Number(slo?.objective);
  if (!(budget > 0)) return [];
  const ctx = { step, pack, series, seriesStep, warn };
  if (!sliLegs(sli, RECORD_WINDOWS[0], ctx)) return [];
  return RECORD_WINDOWS.map(w => ({ record: `${prefix}:errorbudget:burn_${w}`, expr: `${errorRatioAt(sli, w, ctx)} / ${num(budget)}`, labels }));
}

/**
 * Compile a pack's policy (the generator entry, tools/gen-burn-rules.mjs). Options: step (seconds
 * between samples; default from the pack), lab (short `for:`), minBadSamples, runbooks ({ sliId: path }).
 * Returns { groups, recording, burnCount, forecasts, warnings, step }. Unknown SLOs in the policy throw
 * (a generator contract); an SLI without an error-ratio form is warned about and skipped.
 */
export function compileBurnRules(pack, { step, lab = false, minBadSamples = MIN_BAD_SAMPLES, runbooks = {} } = {}) {
  const STEP_SEC = step || packStepSeconds(pack);
  const svc = pack.metadata.name;
  const prefix = metricPrefix(svc);
  const slis = Object.fromEntries((pack.spec.slis || []).map(s => [s.id, s]));
  const slos = Object.fromEntries((pack.spec.slos || []).map(s => [s.id, s]));
  const warnings = [];
  const warn = (m) => { if (!warnings.includes(m)) warnings.push(m); };

  // The pack's own recording rule for a threshold SLI (`expr: ref:slis.<id>`): the policy reads
  // that series at ITS interval (30 s when the rule declares none), never at the scrape step —
  // reading a 30 s series every 15 s counts each recorded point twice and one bad point would
  // satisfy the two-sample floor. Without such a rule the query is inlined at the scrape step.
  const recordedRule = (sliId) => (pack.spec.queries?.recording_rules || []).find(x => strip(x.expr) === `ref:slis.${sliId}`) || null;
  const sliOf = (slo) => {
    const sli = slis[slo.sli];
    if (!sli) throw new Error(`SLO ${slo.id}: unknown SLI ${slo.sli}`);
    return sli;
  };
  // An explicit --step is the step everywhere; otherwise state-style legs are sampled at the
  // scrape interval of the job they select (sliStepSeconds), the pack minimum being the fallback.
  const stepPack = step ? null : pack;
  const ctxOf = (sli) => {
    const rule = sli.type === 'threshold' ? recordedRule(sli.id) : null;
    return rule
      ? { step: STEP_SEC, pack: stepPack, series: rule.name, seriesStep: durationSeconds(rule.interval) || 30, warn }
      : { step: STEP_SEC, pack: stepPack, warn };
  };
  const labelsOf = (slo, sli) => ({ slo: slo.id, sli: sli.id, service: svc });
  const budgeted = (slo) => (1 - Number(slo.objective)) > 0;

  // ----------------------------------------------------------------- recording
  // Threshold error ratios first (one per SLI, in the order its first budgeted SLO appears),
  // then every SLO's burn rates (the order packSnippet documents).
  const recording = [];
  for (const slo of (pack.spec.slos || []).filter(budgeted)) {
    const sli = slis[slo.sli];
    const r = sli && thresholdErrorRatioRule(sli, { prefix, ...ctxOf(sli), labels: { sli: sli.id, service: svc } });
    if (r && !recording.some(x => x.record === r.record)) recording.push(r);
  }
  for (const slo of pack.spec.slos || []) {
    const sli = slis[slo.sli];
    if (sli) recording.push(...errorBudgetRecordingRules(slo, sli, { prefix, ...ctxOf(sli), labels: labelsOf(slo, sli) }));
  }

  // ----------------------------------------------------------------- burn-rate alerts
  const groups = [{ name: `${svc}.errorbudget`, interval: '30s', rules: recording }];
  let burnCount = 0;
  for (const ba of pack.spec.policy?.burn_rate_alerts || []) {
    const slo = slos[ba.slo];
    if (!slo) throw new Error(`policy references unknown SLO ${ba.slo}`);
    const sli = sliOf(slo);
    const budget = 1 - slo.objective;
    const rules = [];
    for (const w of ba.windows || []) {
      const factor = w.factor, short = w.short, long = w.long;
      const threshold = num(factor * budget);
      const name = `${slo.id}_burn_${factor}x_${short}_${long}`.replace(/[^a-zA-Z0-9_]/g, '_');
      const expr = burnAlertExpr(sli, { short, long, threshold, ...ctxOf(sli), minBadSamples });
      if (!expr) continue;
      rules.push({
        alert: name,
        expr,
        for: forFor(short, { lab }),
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
    if (rules.length) groups.push({ name: `${svc}_${slo.id}_burn`, interval: '30s', rules });
  }

  // ----------------------------------------------------------------- forecast alerts (deviation 3)
  const forecasts = [];
  for (const f of pack.spec.policy?.forecasts || []) {
    const slo = slos[f.slo];
    if (!slo) throw new Error(`forecast references unknown SLO ${f.slo}`);
    const burn = `${prefix}:errorbudget:burn_1h{slo="${slo.id}"}`;
    const h = forecastHorizon(f.horizon || '7d');
    const action = f.on_projected_breach || 'open_ticket';
    forecasts.push({
      alert: `${slo.id}_forecast_breach`,
      expr: forecastExpr(burn, h.seconds),
      for: '15m',
      labels: { severity: forecastSeverity(action), pack: svc, slo: slo.id, sli: slo.sli, service: svc, kind: 'forecast' },
      annotations: {
        summary: `${slo.id} has burned faster than its budget for 2h and the trend projects a breach`,
        method: `linear on the 1h burn rate (pack declares ${f.method || 'linear'}; the lab implements linear only)`,
        horizon: h.capped ? `${h.seconds / 86400}d evaluated (pack declares ${h.declared}; capped at the 1d regression window, deviation 5)` : h.declared,
        horizon_declared: h.declared,
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
    out.push(`        labels: { ${Object.entries(r.labels || {}).map(([k, v]) => `${k}: ${v}`).join(', ')} }`);
  }
  return out.join('\n');
}
