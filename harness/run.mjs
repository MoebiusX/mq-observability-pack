#!/usr/bin/env node
// Certification harness entry point.
//
//   node harness/run.mjs                    # conformance + synthetic + chaos (all pack experiments) → reports/
//   node harness/run.mjs --skip-chaos       # fast: conformance + synthetic only → reports/quick/
//   node harness/run.mjs --only chaos --scenario queue-full,dlq-poison
//   node harness/run.mjs --settle 120       # wait N seconds before the first check (fresh stack)
//   node harness/run.mjs --recover          # repair a lab left in a fault state by an interrupted run
//
// Output: cert-report.{json,md,html} in --out (default: reports/ for a full run, reports/quick/
// for any partial run so the full run's report is never overwritten by a quick one).
// Exit code 0 = PASS, 1 = WARN, 2 = FAIL, 3 = the harness itself failed (no verdict).
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { loadPack } from './lib/pack.mjs';
import { composePs, repoRoot } from './lib/docker.mjs';
import { sleep } from './lib/http.mjs';
import { conformance } from './checks/conformance.mjs';
import { synthetic } from './checks/synthetic.mjs';
import { chaos, recoverAll } from './checks/chaos.mjs';
import { renderMarkdown, renderHtml, verdictOf } from './lib/report.mjs';

const SUITES = ['conformance', 'synthetic', 'chaos'];
const EXIT = { PASS: 0, WARN: 1, FAIL: 2, ERROR: 3 };
const argv = process.argv.slice(2);
const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const die = (m) => { log(`usage error: ${m}`); process.exit(EXIT.ERROR); };

const KNOWN = new Set(['--only', '--scenario', '--settle', '--out', '--skip-chaos', '--recover']);
for (const a of argv) if (a.startsWith('--') && !KNOWN.has(a)) die(`unknown flag ${a}`);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v == null || v.startsWith('--')) die(`${n} needs a value`);
  return v;
};
const only = opt('--only')?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
const scenarios = opt('--scenario')?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
const settle = Number(opt('--settle') ?? 0);
if (only) for (const s of only) if (!SUITES.includes(s)) die(`--only ${s}: not one of ${SUITES.join(', ')}`);
if (!Number.isFinite(settle) || settle < 0) die('--settle needs a non-negative number of seconds');

let loaded;
try { loaded = loadPack(); } catch (e) { log(`harness error: cannot load the pack: ${e.message}`); process.exit(EXIT.ERROR); }
const { pack, path } = loaded;
const experimentIds = (pack.spec.validation?.chaos_experiments || []).map(e => e.id);
if (scenarios) for (const s of scenarios) if (!experimentIds.includes(s)) die(`--scenario ${s}: not a pack chaos experiment (${experimentIds.join(', ')})`);

const requested = SUITES.filter(s => (!only || only.includes(s)) && !(s === 'chaos' && flag('--skip-chaos')));
const partial = requested.length < SUITES.length || !!scenarios;
const outDir = resolve(repoRoot, opt('--out') ?? (partial ? 'reports/quick' : 'reports'));

if (flag('--recover')) {
  log(`repairing the lab (every chaos fault's recover): pack ${pack.metadata.name}@${pack.metadata.version}`);
  const r = await recoverAll(pack, { log });
  const ok = r.every(x => x.ok);
  log(ok ? 'lab clean' : 'lab NOT clean — see above');
  process.exit(ok ? 0 : EXIT.FAIL);
}

const startedAt = new Date();
const result = { pack, startedAt: startedAt.toISOString(), requested, conformance: [], synthetic: [], chaos: [] };

const fail = async (err) => {
  log(`harness error: ${err?.stack || err}`);
  result.error = { message: String(err?.message || err), stack: String(err?.stack || '') };
  result.finishedAt = new Date().toISOString();
  result.durationMs = Date.now() - startedAt.getTime();
  result.mttd ??= { n: 0, p50: null, p95: null };
  result.environment ??= { host: hostname(), services: [] };
  result.verdict = 'ERROR';
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, 'cert-report.json'), JSON.stringify(result, null, 2));
    writeFileSync(resolve(outDir, 'cert-report.md'), renderMarkdown(result));
    writeFileSync(resolve(outDir, 'cert-report.html'), renderHtml(result));
    log(`verdict ERROR — partial report written to ${outDir}`);
  } catch (e) { log(`could not write the error report: ${e.message}`); }
  process.exit(EXIT.ERROR);
};
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);

try {
  log(`pack ${pack.metadata.name}@${pack.metadata.version} (${path})`);
  if (settle > 0) { log(`settling ${settle}s so 5m-window SLIs have data`); await sleep(settle * 1000); }

  const ps = await composePs();
  result.environment = {
    host: hostname(),
    services: ps.map(p => ({ service: p.Service, image: p.Image, state: `${p.State}${p.Health ? ` (${p.Health})` : ''}` })).sort((a, b) => a.service.localeCompare(b.service)),
  };

  if (requested.includes('conformance')) { log('conformance…'); result.conformance = await conformance(pack); for (const c of result.conformance) log(`  ${c.status.padEnd(4)} ${c.id} ${c.title} — ${c.detail}`); }
  if (requested.includes('synthetic'))   { log('synthetic…');   result.synthetic = await synthetic(pack);    for (const c of result.synthetic)   log(`  ${c.status.padEnd(4)} ${c.id} ${c.title} — ${c.detail}`); }
  if (requested.includes('chaos'))       { log('chaos…');       result.chaos = await chaos(pack, { only: scenarios, log }); }

  const mttds = result.chaos.flatMap(x => x.alerts.map(a => a.mttdMs)).filter(v => v != null).sort((a, b) => a - b);
  const q = (p) => (mttds.length ? mttds[Math.min(mttds.length - 1, Math.floor(p * (mttds.length - 1) + 0.5))] : null);
  result.mttd = { n: mttds.length, p50: q(0.5), p95: q(0.95) };
  result.emptySuites = requested.filter(s => result[s].length === 0);   // a requested suite that ran nothing is a FAIL, never a PASS
  result.finishedAt = new Date().toISOString();
  result.durationMs = Date.now() - startedAt.getTime();
  result.verdict = verdictOf(result);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'cert-report.json'), JSON.stringify(result, null, 2));
  writeFileSync(resolve(outDir, 'cert-report.md'), renderMarkdown(result));
  writeFileSync(resolve(outDir, 'cert-report.html'), renderHtml(result));
  if (result.emptySuites.length) log(`suite(s) ${result.emptySuites.join(', ')} produced no checks`);
  log(`verdict ${result.verdict} — reports written to ${outDir}/cert-report.{json,md,html}`);
  process.exit(EXIT[result.verdict]);
} catch (err) {
  await fail(err);
}
