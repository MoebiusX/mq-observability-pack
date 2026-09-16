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
// spec.policy → burn-rate / forecast alerts, named as Observogram's compiler names them
// (tools/gen-burn-rules.mjs emits them; this proves the generated file was not left stale).
const alertRules = rules.filter(r => r.alert);
let burnWindows = 0;
for (const ba of pack.spec.policy?.burn_rate_alerts || []) for (const w of ba.windows || []) {
  burnWindows++;
  const name = `${ba.slo}_burn_${w.factor}x_${w.short}_${w.long}`.replace(/[^a-zA-Z0-9_]/g, '_');
  const r = alertRules.find(x => x.alert === name);
  if (!r) { bad++; console.error(`✗ policy window has no alert rule: ${name}`); continue; }
  if (r.labels?.slo !== ba.slo || r.labels?.severity !== w.severity) { bad++; console.error(`✗ ${name}: slo/severity labels do not match the pack window`); }
}
for (const f of pack.spec.policy?.forecasts || []) { const name = `${f.slo}_forecast_breach`; if (!alerts.has(name)) { bad++; console.error(`✗ forecast has no alert rule: ${name}`); } }
// pack recording rules written as literal PromQL must match the stack expression (ref: rules are resolved by the stack author)
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
for (const r of pack.spec.queries.recording_rules) {
  if (/^ref:/.test(norm(r.expr))) continue;
  const cands = rules.filter(x => x.record === r.name && (!r.labels?.slo || x.labels?.slo === r.labels.slo));
  if (cands.length && !cands.some(x => norm(x.expr) === norm(r.expr))) { bad++; console.error(`✗ recording rule ${r.name}${r.labels?.slo ? `{slo="${r.labels.slo}"}` : ''}: pack expr differs from stack expr`); }
}
for (const d of pack.spec.dashboards) if (d.source) {
  const file = d.source.replace(/^file:\/\//, '');
  let json; try { json = JSON.parse(readFileSync(resolve(root, file), 'utf8')); } catch { bad++; console.error(`✗ dashboard file missing: ${file}`); continue; }
  if (json.uid !== d.id) { bad++; console.error(`✗ dashboard uid ${json.uid} != pack id ${d.id}`); }
  const bound = new Set((json.panels || []).map(p => (p.description || '').replace(/^binds_to:\s*/, '')).filter(Boolean));
  for (const b of d.panel_bindings || []) if (!bound.has(b.binds_to)) { bad++; console.error(`✗ ${d.id}: no panel bound to ${b.binds_to}`); }
}
console.log(bad ? `${bad} problem(s)` : `✓ ${records.size} recording rules, ${alerts.size} alert rules (${burnWindows} burn-rate windows, ${(pack.spec.policy?.forecasts || []).length} forecasts), ${pack.spec.dashboards.length} dashboards cross-checked against the pack`);
process.exit(bad ? 1 : 0);
