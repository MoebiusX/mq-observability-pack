#!/usr/bin/env node
// Cross-check: every recording rule name and every alert the pack references must
// exist in stack/prometheus/rules/*.yml, and every chaos expected_alert must be a
// real alert rule. Pure static check (no Prometheus needed) — runs in CI.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from '../vendor/observogram/lib/mini-yaml.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pack = parseYaml(readFileSync(resolve(root, 'packs/ibmmq.pack.yaml'), 'utf8'));
const rulesDir = resolve(root, 'stack/prometheus/rules');
const groups = readdirSync(rulesDir).filter(f => f.endsWith('.yml')).flatMap(f => parseYaml(readFileSync(resolve(rulesDir, f), 'utf8')).groups || []);
const rules = groups.flatMap(g => g.rules);
const records = new Set(rules.filter(r => r.record).map(r => r.record));
const alerts = new Set(rules.filter(r => r.alert).map(r => r.alert));
const key = (s) => String(s).replace(/^alert:/, '').replace(/[-_]/g, '').toLowerCase();
const alertKeys = new Set([...alerts].map(key));

let bad = 0;
for (const r of pack.spec.queries.recording_rules) if (!records.has(r.name)) { bad++; console.error(`✗ recording rule missing in stack: ${r.name}`); }
for (const c of pack.spec.validation.chaos_experiments) for (const a of c.expected_alerts) if (!alertKeys.has(key(a))) { bad++; console.error(`✗ chaos ${c.id} expects unknown alert: ${a}`); }
for (const r of pack.spec.remediation) if (!alertKeys.has(key(r.trigger))) { bad++; console.error(`✗ remediation trigger has no alert rule: ${r.trigger}`); }
for (const d of pack.spec.dashboards) if (d.source) {
  const file = d.source.replace(/^file:\/\//, '');
  let json; try { json = JSON.parse(readFileSync(resolve(root, file), 'utf8')); } catch { bad++; console.error(`✗ dashboard file missing: ${file}`); continue; }
  if (json.uid !== d.id) { bad++; console.error(`✗ dashboard uid ${json.uid} != pack id ${d.id}`); }
  const bound = new Set((json.panels || []).map(p => (p.description || '').replace(/^binds_to:\s*/, '')).filter(Boolean));
  for (const b of d.panel_bindings || []) if (!bound.has(b.binds_to)) { bad++; console.error(`✗ ${d.id}: no panel bound to ${b.binds_to}`); }
}
console.log(bad ? `${bad} problem(s)` : `✓ ${records.size} recording rules, ${alerts.size} alert rules, ${pack.spec.dashboards.length} dashboards cross-checked against the pack`);
process.exit(bad ? 1 : 0);
