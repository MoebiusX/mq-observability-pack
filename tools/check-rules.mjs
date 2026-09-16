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
const sliById = Object.fromEntries((pack.spec.slis || []).map(s => [s.id, s]));

let bad = 0;
for (const r of pack.spec.queries.recording_rules) if (!records.has(r.name)) { bad++; console.error(`✗ recording rule missing in stack: ${r.name}`); }
for (const c of pack.spec.validation.chaos_experiments) for (const a of c.expected_alerts) if (!alertKeys.has(key(a))) { bad++; console.error(`✗ chaos ${c.id} expects unknown alert: ${a}`); }
for (const r of pack.spec.remediation) if (!alertKeys.has(key(r.trigger))) { bad++; console.error(`✗ remediation trigger has no alert rule: ${r.trigger}`); }
// every alert rule carries the labels S5, the dashboards and the harness key on
for (const r of rules.filter(x => x.alert)) {
  for (const l of ['severity', 'pack', 'sli']) if (!r.labels?.[l]) { bad++; console.error(`✗ alert ${r.alert}: missing label ${l}`); }
  if (r.labels?.pack && r.labels.pack !== pack.metadata.name) { bad++; console.error(`✗ alert ${r.alert}: pack label ${r.labels.pack}`); }
  if (r.labels?.sli && !sliById[r.labels.sli]) { bad++; console.error(`✗ alert ${r.alert}: sli label ${r.labels.sli} is not a pack SLI`); }
  if (r.annotations?.runbook && !safeExists(resolve(root, r.annotations.runbook))) { bad++; console.error(`✗ alert ${r.alert}: runbook ${r.annotations.runbook} does not exist`); }
}
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

// Recording rules: the pack and the stack must agree on every expression.
//  * labelled (generated, per-SLO) rules: symmetric — every stack rule with labels.slo needs a
//    pack twin with the same name, slo, sli, service and expression, and vice versa;
//  * literal pack expressions must equal the stack expression;
//  * `ref:slis.<id>` pack rules are resolved to the SLI's own query (threshold SLIs) or
//    good/total (ratio SLIs) and compared with the stack rule — this is the expression the
//    burn-rate generator and the dashboards actually read, so a stack edit that drifts from
//    the pack SLI must fail here, not stay invisible. A ratio SLI's stack rule may be the 5 m
//    smoothing of the pack fraction; then it must at least use exactly the pack's selectors.
const norm = (s) => String(s ?? '').replace(/\s+/g, '').trim();
const rkey = (name, l, expr) => `${name}|${l?.slo}|${l?.sli}|${l?.service}|${norm(expr)}`;
const stackSlo = new Set(rules.filter(x => x.record && x.labels?.slo).map(x => rkey(x.record, x.labels, x.expr)));
const packSlo = new Set(pack.spec.queries.recording_rules.filter(r => r.labels?.slo).map(r => rkey(r.name, r.labels, r.expr)));
for (const k of packSlo) if (!stackSlo.has(k)) { bad++; const [n, s] = k.split('|'); console.error(`✗ recording rule ${n}{slo="${s}"}: pack entry has no identical stack rule (regenerate: node tools/gen-burn-rules.mjs --pack-snippet)`); }
for (const k of stackSlo) if (!packSlo.has(k)) { bad++; const [n, s] = k.split('|'); console.error(`✗ recording rule ${n}{slo="${s}"}: stack rule missing from the pack (paste tools/gen-burn-rules.mjs --pack-snippet)`); }
const selectors = (e) => [...String(e).matchAll(/[a-zA-Z_:][a-zA-Z0-9_:]*\{[^}]*\}/g)].map(m => norm(m[0])).sort().join(' ');
let refResolved = 0;
for (const r of pack.spec.queries.recording_rules) {
  if (r.labels?.slo) continue;
  const cands = rules.filter(x => x.record === r.name && !x.labels?.slo);
  if (!cands.length) continue;   // reported above as missing
  const ref = /^ref:slis\.([A-Za-z0-9_-]+)$/.exec(String(r.expr).trim());
  if (!ref) {
    if (!cands.some(x => norm(x.expr) === norm(r.expr))) { bad++; console.error(`✗ recording rule ${r.name}: pack expr differs from stack expr`); }
    continue;
  }
  const sli = sliById[ref[1]];
  if (!sli) { bad++; console.error(`✗ recording rule ${r.name}: ${r.expr} is not a pack SLI`); continue; }
  refResolved++;
  if (sli.type === 'threshold') {
    const want = norm(sli.query || sli.expression);
    if (!cands.some(x => norm(x.expr) === want)) { bad++; console.error(`✗ recording rule ${r.name}: stack expr differs from the pack SLI ${sli.id} query it claims to record`); }
  } else {
    const exact = [`(${sli.good})/(${sli.total})`, `${sli.good}/${sli.total}`].map(norm);
    const wantSel = selectors(`${sli.good} ${sli.total}`);
    const ok = cands.some(x => exact.includes(norm(x.expr)) || selectors(x.expr) === wantSel);
    if (!ok) { bad++; console.error(`✗ recording rule ${r.name}: stack expr does not use the selectors of pack SLI ${sli.id} (good/total)`); }
  }
}
for (const d of pack.spec.dashboards) if (d.source) {
  const file = d.source.replace(/^file:\/\//, '');
  let json; try { json = JSON.parse(readFileSync(resolve(root, file), 'utf8')); } catch { bad++; console.error(`✗ dashboard file missing: ${file}`); continue; }
  if (json.uid !== d.id) { bad++; console.error(`✗ dashboard uid ${json.uid} != pack id ${d.id}`); }
  const panels = (json.panels || []).flatMap(p => [p, ...(p.panels || [])]);   // rows may nest panels when collapsed
  const bound = new Set(panels.map(p => (p.description || '').replace(/^binds_to:\s*/, '')).filter(Boolean));
  for (const b of d.panel_bindings || []) if (!bound.has(b.binds_to)) { bad++; console.error(`✗ ${d.id}: no panel bound to ${b.binds_to}`); }
}
console.log(bad ? `${bad} problem(s)` : `✓ ${records.size} recording rules (${refResolved} ref: rules resolved to their SLI), ${alerts.size} alert rules (${burnWindows} burn-rate windows, ${(pack.spec.policy?.forecasts || []).length} forecasts), ${pack.spec.dashboards.length} dashboards cross-checked against the pack`);
process.exit(bad ? 1 : 0);

function safeExists(p) { try { readFileSync(p); return true; } catch { return false; } }
