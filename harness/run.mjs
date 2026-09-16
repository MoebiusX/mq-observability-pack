#!/usr/bin/env node
// Certification harness entry point.
//
//   node harness/run.mjs                    # conformance + synthetic + chaos (all pack experiments)
//   node harness/run.mjs --skip-chaos       # fast: conformance + synthetic only
//   node harness/run.mjs --only chaos --scenario queue-full,dlq-poison
//   node harness/run.mjs --settle 120       # wait N seconds before the first check (fresh stack)
//
// Output: reports/cert-report.{json,md,html}. Exit code 0 = PASS, 1 = WARN, 2 = FAIL.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { loadPack } from './lib/pack.mjs';
import { composePs, repoRoot } from './lib/docker.mjs';
import { sleep } from './lib/http.mjs';
import { conformance } from './checks/conformance.mjs';
import { synthetic } from './checks/synthetic.mjs';
import { chaos } from './checks/chaos.mjs';
import { renderMarkdown, renderHtml, verdictOf } from './lib/report.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const only = opt('--only', null)?.split(',');
const scenarios = opt('--scenario', null)?.split(',');
const settle = Number(opt('--settle', 0));
const outDir = resolve(repoRoot, opt('--out', 'reports'));
const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);

const run = (suite) => !only || only.includes(suite);
const { pack, path } = loadPack();
const startedAt = new Date();
log(`pack ${pack.metadata.name}@${pack.metadata.version} (${path})`);

if (settle > 0) { log(`settling ${settle}s so 5m-window SLIs have data`); await sleep(settle * 1000); }

const ps = await composePs();
const environment = {
  host: hostname(),
  services: ps.map(p => ({ service: p.Service, image: p.Image, state: `${p.State}${p.Health ? ` (${p.Health})` : ''}` })).sort((a, b) => a.service.localeCompare(b.service)),
};

const result = { pack, startedAt: startedAt.toISOString(), environment, conformance: [], synthetic: [], chaos: [] };

if (run('conformance')) { log('conformance…'); result.conformance = await conformance(pack); for (const c of result.conformance) log(`  ${c.status.padEnd(4)} ${c.id} ${c.title} — ${c.detail}`); }
if (run('synthetic'))   { log('synthetic…');   result.synthetic = await synthetic(pack);    for (const c of result.synthetic)   log(`  ${c.status.padEnd(4)} ${c.id} ${c.title} — ${c.detail}`); }
if (run('chaos') && !flag('--skip-chaos')) { log('chaos…'); result.chaos = await chaos(pack, { only: scenarios, log }); }

const mttds = result.chaos.flatMap(x => x.alerts.map(a => a.mttdMs)).filter(v => v != null).sort((a, b) => a - b);
const q = (p) => (mttds.length ? mttds[Math.min(mttds.length - 1, Math.floor(p * (mttds.length - 1) + 0.5))] : null);
result.mttd = { n: mttds.length, p50: q(0.5), p95: q(0.95) };
result.finishedAt = new Date().toISOString();
result.durationMs = Date.now() - startedAt.getTime();
result.verdict = verdictOf(result);

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'cert-report.json'), JSON.stringify(result, null, 2));
writeFileSync(resolve(outDir, 'cert-report.md'), renderMarkdown(result));
writeFileSync(resolve(outDir, 'cert-report.html'), renderHtml(result));
log(`verdict ${result.verdict} — reports written to ${outDir}/cert-report.{json,md,html}`);
process.exit({ PASS: 0, WARN: 1, FAIL: 2 }[result.verdict]);
