// Load packs/ibmmq.pack.yaml and derive what the harness needs from it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from '../../vendor/observogram/lib/mini-yaml.mjs';
import { repoRoot } from './docker.mjs';

export function loadPack(file = process.env.PACK || 'packs/ibmmq.pack.yaml') {
  const path = resolve(repoRoot, file);
  const pack = parseYaml(readFileSync(path, 'utf8'));
  return { path, pack };
}

/** Executable PromQL for an SLI: ratio → good/total, threshold → query. */
export function sliExpr(sli) {
  if (sli.type === 'ratio') return `(${sli.good.trim()}) / (${sli.total.trim()})`;
  return (sli.query || sli.expression || '').trim();
}

/** Recording-rule names declared by the pack (deduplicated). */
export function recordingRuleNames(pack) {
  return [...new Set((pack.spec.queries?.recording_rules || []).map(r => r.name))];
}

/** Normalise an alert identifier for comparison: strip 'alert:' prefix, dashes/underscores, lowercase. */
export const alertKey = (s) => String(s).replace(/^alert:/, '').replace(/[-_]/g, '').toLowerCase();

/**
 * Every alertname the pack references: chaos expected_alerts ∪ remediation triggers ∪ the
 * burn-rate and forecast alerts implied by spec.policy (named as Observogram's compiler
 * names them, which is what tools/gen-burn-rules.mjs emits).
 */
export function referencedAlerts(pack) {
  const fromChaos = (pack.spec.validation?.chaos_experiments || []).flatMap(c => c.expected_alerts || []);
  const fromRemediation = (pack.spec.remediation || []).map(r => r.trigger);
  const fromPolicy = (pack.spec.policy?.burn_rate_alerts || []).flatMap(ba => (ba.windows || []).map(w => `${ba.slo}_burn_${w.factor}x_${w.short}_${w.long}`.replace(/[^a-zA-Z0-9_]/g, '_')));
  const fromForecast = (pack.spec.policy?.forecasts || []).map(f => `${f.slo}_forecast_breach`);
  const map = new Map();
  for (const a of [...fromChaos, ...fromRemediation, ...fromPolicy, ...fromForecast]) map.set(alertKey(a), a);
  return map; // key → as written in pack
}

export function durationToMs(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!m) return NaN;
  const n = Number(m[1]);
  return { ms: n, s: n * 1e3, m: n * 6e4, h: n * 36e5, d: n * 864e5 }[m[2]];
}
