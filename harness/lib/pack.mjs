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

/** Every alertname the pack references (chaos expected_alerts ∪ remediation triggers). */
export function referencedAlerts(pack) {
  const fromChaos = (pack.spec.validation?.chaos_experiments || []).flatMap(c => c.expected_alerts || []);
  const fromRemediation = (pack.spec.remediation || []).map(r => r.trigger);
  const map = new Map();
  for (const a of [...fromChaos, ...fromRemediation]) map.set(alertKey(a), a);
  return map; // key → as written in pack
}

export function durationToMs(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!m) return NaN;
  const n = Number(m[1]);
  return { ms: n, s: n * 1e3, m: n * 6e4, h: n * 36e5, d: n * 864e5 }[m[2]];
}
