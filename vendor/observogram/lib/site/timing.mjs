// tools/lib/site/timing.mjs
//
// The timing model of one environment (gen-site design §5.1): every window, `for:` and
// Alertmanager damping the emitted files use, derived from the scrape step and the pack's
// closed override vocabulary. Pure ESM, browser-safe; siblings by relative path only.
//
// Precedence
//   step  = envModel.scrape_interval ?? overrides['prometheus.scrape_interval'] ?? packStepSeconds(pack)
//   poll  = params.exporter_poll_interval ?? overrides['exporter.poll_interval'] ?? step
//   probe = params.canary_interval ?? step
//
// Derived (seconds; `dur()` renders them)
//   window3 = 3*step          gate = max(60, 6*step)       keepFiring = 6*step
//   subq = step               canaryShort = 4*probe        canaryHung = 12*probe
//   interval = step           timeInterval = step          scrapeTimeout = min(8, step - 2)
//   symptomFor(literal) = max(literal, overrides['alerts.symptom.for'])   (the literal when no override)
//   evalScale = step / 10     (promtool eval_time = lab value × evalScale; the lab step is 10 s)
//
// dur(seconds): '1m' for 60, '<n>s' otherwise, so the lab (step 10) reproduces its literals
// ([30s], [1m], keep_firing_for: 1m). A string is returned unchanged: values that come from an
// override ('2m', '5m') keep the spelling the pack declares. durM() is the minutes-first spelling
// ('2m' for 120, '90s' for 90) for templates whose lab literal is written in minutes.
//
// Closed vocabulary: any key under alerts.*, alertmanager.*, prometheus.* or exporter.* that is
// not in OVERRIDE_KEYS is an error (the pack declares, this module is its only reader). Other
// keys (storage.*, otel.*) pass through untouched in `passthrough`.

import { durationSeconds, packStepSeconds } from '../burn-rules.mjs';

export const OVERRIDE_KEYS = Object.freeze([
  'prometheus.scrape_interval',
  'exporter.poll_interval',
  'alerts.symptom.for',
  'alerts.burn_rate.for.short_5m',
  'alerts.burn_rate.for.short_30m',
  'alerts.burn_rate.for.short_1h',
  'alertmanager.group_wait',
  'alertmanager.group_wait.sev1',
]);
const CLOSED_PREFIXES = ['alerts.', 'alertmanager.', 'prometheus.', 'exporter.'];
export const MIN_BAD_SAMPLES = 2;
export const LAB_STEP = 10;

/** Seconds → Prometheus duration: 60 → '1m', anything else → '<n>s'. Strings pass through. */
export function dur(v) {
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v) || v < 0) throw new Error(`dur: not a duration: ${JSON.stringify(v)}`);
  const n = Number.isInteger(v) ? v : Number(v.toFixed(3));
  return n === 60 ? '1m' : `${n}s`;
}

/** Seconds → minutes-first spelling: whole minutes as '<n>m', otherwise '<n>s'. Strings pass through. */
export function durM(v) {
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v) || v < 0) throw new Error(`durM: not a duration: ${JSON.stringify(v)}`);
  return v >= 60 && v % 60 === 0 ? `${v / 60}m` : `${v}s`;
}

/** Duration string or number of seconds → seconds. */
export function secs(v) {
  if (typeof v === 'number') return v;
  return durationSeconds(v);
}

/** The pack's overrides for an environment split into the timing vocabulary and the rest; throws on unknown closed keys. */
export function readOverrides(pack, env) {
  const raw = pack?.spec?.environments?.[env]?.overrides || {};
  const timing = {}, passthrough = {}, unknown = [];
  for (const [k, v] of Object.entries(raw)) {
    if (OVERRIDE_KEYS.includes(k)) timing[k] = v;
    else if (CLOSED_PREFIXES.some(p => k.startsWith(p))) unknown.push(k);
    else passthrough[k] = v;
  }
  if (unknown.length) throw new Error(`spec.environments.${env}.overrides: unknown key${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} (the closed vocabulary is ${OVERRIDE_KEYS.join(', ')})`);
  return { timing, passthrough };
}

/** Which declared burn `for:` override a short window falls under (the library's forFor() buckets). */
export function burnBucket(shortWindow) {
  const s = secs(shortWindow);
  return s <= 300 ? 'short_5m' : s <= 1800 ? 'short_30m' : 'short_1h';
}

/**
 * timing(pack, env, envModel, params) → Timing. `envModel.scrape_interval` and the site params
 * (`exporter_poll_interval`, `canary_interval`) come from the inventory; the overrides from the
 * pack's spec.environments.<env>.
 */
export function timing(pack, env, envModel = {}, params = undefined) {
  const p = params ?? envModel?.params ?? {};
  const { timing: ov, passthrough } = readOverrides(pack, env);
  const step = envModel?.scrape_interval != null ? secs(envModel.scrape_interval) : ov['prometheus.scrape_interval'] != null ? secs(ov['prometheus.scrape_interval']) : packStepSeconds(pack);
  const poll = p.exporter_poll_interval != null ? secs(p.exporter_poll_interval) : ov['exporter.poll_interval'] != null ? secs(ov['exporter.poll_interval']) : step;
  const probe = p.canary_interval != null ? secs(p.canary_interval) : step;
  const lab = env === 'lab';
  const symptomOverride = ov['alerts.symptom.for'] ?? null;
  const burnFor = { short_5m: ov['alerts.burn_rate.for.short_5m'] ?? null, short_30m: ov['alerts.burn_rate.for.short_30m'] ?? null, short_1h: ov['alerts.burn_rate.for.short_1h'] ?? null };
  const groupWait = ov['alertmanager.group_wait'] ?? '5s';
  const groupWaitSev1 = ov['alertmanager.group_wait.sev1'] ?? '2s';

  /** max(literal, alerts.symptom.for): the override's own spelling when it wins, the literal's otherwise. */
  const symptomFor = (literal) => {
    if (symptomOverride == null) return literal;
    return secs(symptomOverride) > secs(literal) ? symptomOverride : literal;
  };

  const t = {
    env, lab, step, poll, probe,
    window3: 3 * step,
    subq: step,
    gate: Math.max(60, 6 * step),
    canaryShort: 4 * probe,
    canaryHung: 12 * probe,
    keepFiring: 6 * step,
    interval: step,
    timeInterval: step,
    scrapeTimeout: Math.min(8, step - 2),
    evalScale: step / LAB_STEP,
    minBadSamples: MIN_BAD_SAMPLES,
    symptomForOverride: symptomOverride,
    symptomFor,
    burnFor,
    alertmanager: {
      group_wait: groupWait,
      group_wait_sev1: groupWaitSev1,
      group_interval: lab ? '10s' : '5m',
      repeat_interval: lab ? '1h' : '4h',
      resolve_timeout: dur(Math.max(60, 2 * step)),
    },
    overrides: ov,
    passthrough,
    dur, durM, secs,
  };

  /** Errors for every burn-rate alert whose emitted `for:` differs from the declared override of its short window. */
  t.assertBurnFor = (groups) => {
    const errors = [];
    for (const g of groups || []) for (const r of g.rules || []) {
      if (!r.alert || !r.labels?.window_short) continue;
      const bucket = burnBucket(r.labels.window_short);
      const declared = burnFor[bucket];
      if (declared == null) continue;
      if (secs(declared) !== secs(r.for)) errors.push(`burn-rate alert ${r.alert}: emitted for: ${r.for}, the pack declares alerts.burn_rate.for.${bucket}: ${declared} for environment ${env}`);
    }
    return errors;
  };

  /**
   * Chaos expected_mttd rebudget (seconds): lab + (for_env − for_lab) + (group_wait − 5s) + 2*(step − 10s).
   * `forLab` is the alert's lab `for:` literal; `forEnv` defaults to symptomFor(forLab).
   */
  t.rebudgetMttd = (labExpected, forLab, forEnv = symptomFor(forLab)) =>
    secs(labExpected) + (secs(forEnv) - secs(forLab)) + (secs(groupWait) - 5) + 2 * (step - LAB_STEP);

  return t;
}

/** The JSON-serialisable part of a Timing (for site.json). */
export function timingManifest(t) {
  const { symptomFor: _f, assertBurnFor: _a, rebudgetMttd: _r, dur: _d, durM: _m, secs: _s, ...rest } = t;
  return {
    ...rest,
    rendered: {
      window3: dur(t.window3), subq: dur(t.subq), gate: dur(t.gate), canaryShort: dur(t.canaryShort), canaryHung: dur(t.canaryHung),
      keepFiring: dur(t.keepFiring), interval: dur(t.interval), timeInterval: dur(t.timeInterval), step: dur(t.step), poll: dur(t.poll), probe: dur(t.probe),
    },
  };
}
