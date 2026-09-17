#!/usr/bin/env node
// Certification harness entry point.
//
//   node harness/run.mjs                    # conformance + synthetic + chaos (all pack experiments) → reports/
//   node harness/run.mjs --skip-chaos       # fast: conformance + synthetic only → reports/quick/
//   node harness/run.mjs --only chaos --scenario queue-full,dlq-poison
//   node harness/run.mjs --settle 120       # wait N seconds before the first check (fresh stack)
//   node harness/run.mjs --recover          # repair a lab left in a fault state by an interrupted run
//   node harness/run.mjs --publish reports/cert-report.json   # re-publish a report's results to the alert-sink
//
// Output: cert-report.{json,md,html} in --out (default: reports/ for a full run, reports/quick/
// for any partial run so the full run's report is never overwritten by a quick one). Every run
// also publishes its summary (verdict, checks, MTTD/MTTR per alert) to the alert-sink, which
// exposes it at /metrics so the dashboards show MTTD and MTTR next to the SLOs.
// Exit code 0 = PASS, 1 = WARN, 2 = FAIL, 3 = the harness itself failed (no verdict).
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { loadPack } from './lib/pack.mjs';
import { composePs, repoRoot } from './lib/docker.mjs';
import { sleep, cfg } from './lib/http.mjs';
import { conformance } from './checks/conformance.mjs';
import { synthetic } from './checks/synthetic.mjs';
import { chaos, recoverAll } from './checks/chaos.mjs';
import { renderMarkdown, renderHtml, verdictOf } from './lib/report.mjs';

const SUITES = ['conformance', 'synthetic', 'chaos'];
const EXIT = { PASS: 0, WARN: 1, FAIL: 2, ERROR: 3 };
const argv = process.argv.slice(2);
const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const die = (m) => { log(`usage error: ${m}`); process.exit(EXIT.ERROR); };

const KNOWN = new Set(['--only', '--scenario', '--settle', '--out', '--skip-chaos', '--recover', '--publish']);
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

/** The part of a run the dashboards show: verdict, checks per suite, MTTD/MTTR per alert. */
function certSummary(r) {
  const count = (list) => { const c = {}; for (const x of list || []) c[x.status] = (c[x.status] || 0) + 1; return c; };
  return {
    packVersion: r.pack?.metadata?.version, verdict: r.verdict, startedAt: r.startedAt, finishedAt: r.finishedAt, durationMs: r.durationMs,
    checks: { conformance: count(r.conformance), synthetic: count(r.synthetic), chaos: count(r.chaos) },
    mttd: r.mttd, mttr: r.mttr,
    experiments: (r.chaos || []).map(x => ({ id: x.id, status: x.status, expectedMttdMs: x.expectedMttdMs, alerts: (x.alerts || []).map(a => ({ alertname: a.alertname, mttdMs: a.mttdMs, resolvedAfterMs: a.resolvedAfterMs })) })),
  };
}
async function publish(summary) {
  try {
    const r = await fetch(new URL('/results', cfg.sink), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(summary), signal: AbortSignal.timeout(5000) });
    log(r.ok ? `results published to the alert-sink (${cfg.sink}/metrics)` : `alert-sink refused the results: HTTP ${r.status}`);
    return r.ok;
  } catch (e) { log(`could not publish results to the alert-sink: ${e.message}`); return false; }
}
if (opt('--publish') !== null) {
  const file = resolve(repoRoot, opt('--publish'));
  let report;
  try { report = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { log(`harness error: cannot read ${file}: ${e.message}`); process.exit(EXIT.ERROR); }
  if (!report.verdict) die(`${file} is not a certification report`);
  if (!report.mttr) report.mttr = quantiles((report.chaos || []).flatMap(x => x.alerts.map(a => a.resolvedAfterMs)));
  process.exit((await publish(certSummary(report))) ? 0 : EXIT.FAIL);
}
function quantiles(values) {
  const v = values.filter(x => x != null).sort((a, b) => a - b);
  const q = (p) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))] : null);
  return { n: v.length, p50: q(0.5), p95: q(0.95) };
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

  result.mttd = quantiles(result.chaos.flatMap(x => x.alerts.map(a => a.mttdMs)));
  result.mttr = quantiles(result.chaos.flatMap(x => x.alerts.map(a => a.resolvedAfterMs)));   // resolution after recovery: the observability system's share of MTTR
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
  // Only a complete run (every suite, every experiment) represents the pack on the boards; a
  // quick or partial run would replace the MTTD/MTTR figures with nothing.
  if (!partial) await publish(certSummary(result)); else log('partial run: results not published to the alert-sink (a full run or --publish does that)');
  process.exit(EXIT[result.verdict]);
} catch (err) {
  await fail(err);
}
