#!/usr/bin/env node
/**
 * tools/reference-packs.mjs — validate Observogram's reference packs (grafana, prometheus) live,
 * against this lab's own platform components.
 *
 * The lab scrapes Prometheus, Alertmanager, Grafana, Loki and Tempo (stack/prometheus/prometheus.yml,
 * rendered by tools/site/templates/prometheus.mjs). Observogram's reference packs describe two of
 * those components; their generated boards read the packs' recording rules and the policy's
 * error-budget records, so without those rules loaded every panel is empty. This tool:
 *
 *   1. reads each pack, its generated burn-rate rules and its boards from an Observogram git ref
 *      (no working tree needed: `git show <ref>:<path>`), records the commit;
 *   2. materialises the pack's spec.queries.recording_rules (a `ref:slis.<id>` expression becomes
 *      the SLI's query, or `(good) / (total)` for a ratio SLI) into
 *      stack/prometheus/rules-reference/<pack>.recording.yml, and copies the burn-rate rules next to
 *      it — Prometheus loads that directory (compose mount + rule_files); check-rules does not read
 *      it, so the MQ pack's own cross-check is untouched. A declared rule whose name the policy
 *      generates with labels (<pack>:errorbudget:burn_*) is skipped: the same series name with a
 *      different value would collide;
 *   3. --import: puts the boards into the lab Grafana's "Reference packs (generated)" folder;
 *   4. --validate: reloads Prometheus, waits for the rules to evaluate, then reports which
 *      recording rules produce samples and, per board, how many Prometheus panels return data,
 *      which are empty (the pack names a metric this component version does not expose, or the
 *      lab has no such traffic) and which error. Errors fail the run; empties are listed.
 *
 *   node tools/reference-packs.mjs [--observogram ../Observogram] [--ref origin/develop]
 *        [--packs grafana,prometheus] [--out stack/prometheus/rules-reference]
 *        [--import] [--validate] [--wait 150] [--no-reload]
 *   npm run refpacks            # --import --validate
 *
 * Endpoints: PROM_URL (default http://127.0.0.1:29090), GRAFANA_URL (http://127.0.0.1:23000),
 * GRAFANA_AUTH (admin:admin). Node >= 20 built-ins only.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from '../vendor/observogram/lib/mini-yaml.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
if (has('--help') || has('-h')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 32).join('\n')); process.exit(0); }
const OG = resolve(ROOT, opt('--observogram', '../Observogram'));
const REF = opt('--ref', 'origin/develop');
const PACKS = opt('--packs', 'grafana,prometheus').split(',').map(s => s.trim()).filter(Boolean);
const OUT = resolve(ROOT, opt('--out', 'stack/prometheus/rules-reference'));
const WAIT = Number(opt('--wait', '150'));
const PROM = process.env.PROM_URL || 'http://127.0.0.1:29090';
const GRAFANA = process.env.GRAFANA_URL || 'http://127.0.0.1:23000';
const AUTH = 'Basic ' + Buffer.from(process.env.GRAFANA_AUTH || 'admin:admin').toString('base64');

const git = (...args) => execFileSync('git', ['-C', OG, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const show = (path) => git('show', `${REF}:${path}`);
const commit = git('rev-parse', '--short', REF).trim();
const remote = (() => { try { return git('remote', 'get-url', 'origin').trim(); } catch { return OG; } })();
console.log(`Observogram ${remote} @ ${REF} (${commit}) → ${OUT}`);
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- materialise the rules
const sliExpr = (sli) => {
  if (sli.type === 'ratio') return `(${String(sli.good).trim()}) / (${String(sli.total).trim()})`;
  return String(sli.query ?? sli.expression ?? '').trim();
};
const yamlBlock = (expr, indent) => (expr.includes('\n') || expr.includes(': ') || expr.includes(' #') ? `|\n${expr.split('\n').map(l => `${indent}  ${l}`).join('\n')}` : expr);
const written = [];
const packs = {};
for (const name of PACKS) {
  const pack = parseYaml(show(`reference-packs/${name}.pack.yaml`));
  const svc = pack.metadata.name;
  packs[name] = { pack, svc, recording: [], burn: [], boards: [] };
  const slis = Object.fromEntries((pack.spec.slis || []).map(s => [s.id, s]));
  const byInterval = new Map();
  const skipped = [];
  for (const r of pack.spec.queries?.recording_rules || []) {
    if (new RegExp(`^${svc}:errorbudget:burn_`).test(r.name)) { skipped.push(r.name); continue; }
    const ref = /^ref:slis\.([A-Za-z0-9_-]+)$/.exec(String(r.expr).trim());
    let expr;
    if (ref) {
      const sli = slis[ref[1]];
      if (!sli) { console.error(`✗ ${name}: recording rule ${r.name} references unknown SLI ${ref[1]}`); process.exit(1); }
      expr = sliExpr(sli);
    } else expr = String(r.expr).trim();
    const iv = r.interval || '1m';
    if (!byInterval.has(iv)) byInterval.set(iv, []);
    byInterval.get(iv).push({ record: r.name, expr, labels: r.labels || null });
    packs[name].recording.push(r.name);
  }
  const lines = [
    `# Recording rules of Observogram's ${name} reference pack (${svc} ${pack.metadata.version}), materialised by`,
    `# tools/reference-packs.mjs from ${remote} ${REF} (${commit}) reference-packs/${name}.pack.yaml`,
    `# spec.queries.recording_rules: ref:slis.<id> expanded to the SLI query, or (good) / (total) for a`,
    `# ratio SLI. For live validation of the pack against this lab only; not part of the MQ pack. Do not`,
    `# edit: rerun the tool.${skipped.length ? ` Skipped (the policy generates them with labels): ${skipped.join(', ')}.` : ''}`,
    'groups:',
  ];
  for (const [iv, rules] of byInterval) {
    lines.push(`  - name: ${svc}.reference.recording.${iv}`, `    interval: ${iv}`, '    rules:');
    for (const r of rules) {
      lines.push(`      - record: ${r.record}`, `        expr: ${yamlBlock(r.expr, '        ')}`);
      if (r.labels) lines.push(`        labels: { ${Object.entries(r.labels).map(([k, v]) => `${k}: ${v}`).join(', ')} }`);
    }
  }
  const recFile = resolve(OUT, `${name}.recording.yml`);
  writeFileSync(recFile, lines.join('\n') + '\n');
  written.push(recFile);
  // the burn-rate rules Observogram generated for the pack (tools/gen-burn-rules.mjs there)
  let burn = null;
  try { burn = show(`reference-packs/rules/${name}.burn.yml`); } catch { console.log(`  ${name}: no reference-packs/rules/${name}.burn.yml at ${REF}`); }
  if (burn) {
    const burnFile = resolve(OUT, `${name}.burn.yml`);
    writeFileSync(burnFile, `# Copied by tools/reference-packs.mjs from ${remote} ${REF} (${commit}) reference-packs/rules/${name}.burn.yml — do not edit.\n${burn}`);
    written.push(burnFile);
    const doc = parseYaml(burn);
    packs[name].burn = (doc.groups || []).flatMap(g => g.rules || []).filter(r => r.record).map(r => r.record);
  }
  const boardFiles = git('ls-tree', '--name-only', REF, 'reference-packs/dashboards/').split('\n').filter(f => basename(f).startsWith(`${name}-`) && f.endsWith('.json'));
  packs[name].boards = boardFiles.map(f => ({ file: basename(f), dashboard: JSON.parse(show(f)) }));
  console.log(`  ${name} (${svc} ${pack.metadata.version}): ${packs[name].recording.length} recording rules${skipped.length ? ` (${skipped.length} skipped)` : ''}, ${packs[name].burn.length} policy records, ${packs[name].boards.length} boards`);
}
const stale = readdirSync(OUT).filter(f => /\.(yml|yaml)$/.test(f) && !written.some(w => basename(w) === f));
if (stale.length) console.log(`  note: ${stale.join(', ')} in ${OUT} come from another run (not touched)`);

// ---------------------------------------------------------------- Prometheus and Grafana
const fetchJson = async (url, init) => { const r = await fetch(url, init); let j = null; try { j = await r.json(); } catch { /* not json */ } return { status: r.status, body: j }; };
const query = async (expr) => fetchJson(`${PROM}/api/v1/query?query=${encodeURIComponent(expr)}`);
const reachable = async (url) => { try { const r = await fetch(url); return r.ok || r.status < 500; } catch { return false; } };

if (!has('--no-reload')) {
  if (await reachable(`${PROM}/-/ready`)) {
    const r = await fetch(`${PROM}/-/reload`, { method: 'POST' });
    console.log(`Prometheus reload: HTTP ${r.status}${r.status === 200 ? '' : ' (is the rules-reference directory mounted? docker compose up -d prometheus)'}`);
  } else console.log(`Prometheus at ${PROM} not reachable: files written, nothing reloaded`);
}

if (has('--import')) {
  if (!(await reachable(`${GRAFANA}/api/health`))) { console.error(`✗ Grafana at ${GRAFANA} not reachable`); process.exit(1); }
  const hdr = { 'content-type': 'application/json', authorization: AUTH };
  const folderUid = 'refpacks-generated';
  let f = await fetchJson(`${GRAFANA}/api/folders/${folderUid}`, { headers: hdr });
  if (f.status === 404) f = await fetchJson(`${GRAFANA}/api/folders`, { method: 'POST', headers: hdr, body: JSON.stringify({ uid: folderUid, title: 'Reference packs (generated)' }) });
  let ok = 0, bad = 0;
  for (const p of Object.values(packs)) for (const b of p.boards) {
    const dash = { ...b.dashboard, id: null };
    const r = await fetchJson(`${GRAFANA}/api/dashboards/db`, { method: 'POST', headers: hdr, body: JSON.stringify({ dashboard: dash, folderUid, overwrite: true, message: `Observogram ${REF} ${commit}` }) });
    const good = r.status === 200 && r.body?.status === 'success';
    good ? ok++ : bad++;
    if (!good) console.log(`  FAIL import ${b.file}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  }
  console.log(`Grafana import into "Reference packs (generated)": ${ok} boards ok, ${bad} failed`);
  if (bad) process.exit(1);
}

if (has('--validate')) {
  if (!(await reachable(`${PROM}/-/ready`))) { console.error(`✗ Prometheus at ${PROM} not reachable`); process.exit(1); }
  // wait until every materialised group has evaluated at least once (or the budget is spent)
  const wanted = new Set(Object.values(packs).flatMap(p => [`${p.svc}.reference.recording.`]));
  const t0 = Date.now();
  for (;;) {
    const r = await fetchJson(`${PROM}/api/v1/rules`);
    const groups = r.body?.data?.groups || [];
    const ours = groups.filter(g => [...wanted].some(w => g.name.startsWith(w)));
    const evaluated = ours.length && ours.every(g => g.lastEvaluation && !g.lastEvaluation.startsWith('0001'));
    const elapsed = (Date.now() - t0) / 1000;
    if ((evaluated && elapsed >= Math.min(WAIT, 60)) || elapsed >= WAIT) break;
    await new Promise(res => setTimeout(res, 5000));
  }
  const rulesApi = (await fetchJson(`${PROM}/api/v1/rules`)).body?.data?.groups || [];
  let failures = 0;
  for (const [name, p] of Object.entries(packs)) {
    console.log(`\n== ${name}`);
    const groups = rulesApi.filter(g => g.name.startsWith(`${p.svc}.reference.`) || g.name.startsWith(`${p.svc}.errorbudget`) || g.name.startsWith(`${p.svc}.forecast`) || g.name.startsWith(`${p.svc}_`));
    const unhealthy = groups.flatMap(g => (g.rules || []).filter(r => r.health !== 'ok').map(r => `${r.name}: ${r.health}${r.lastError ? ` (${r.lastError})` : ''}`));
    console.log(`rule groups loaded: ${groups.length} (${groups.reduce((n, g) => n + (g.rules || []).length, 0)} rules)${unhealthy.length ? `; UNHEALTHY: ${unhealthy.join('; ')}` : ', all healthy'}`);
    failures += unhealthy.length;
    const producing = [], empty = [];
    for (const rec of [...new Set([...p.recording, ...p.burn])]) {
      const r = await query(`count({__name__="${rec}"})`);
      (r.body?.data?.result?.length ? producing : empty).push(rec);
    }
    console.log(`recording rules producing samples: ${producing.length}/${producing.length + empty.length}${empty.length ? `; empty: ${empty.join(', ')}` : ''}`);
    for (const b of p.boards) {
      const targets = [];
      const walk = (panel) => { for (const t of panel.targets || []) if (t.expr && (panel.datasource?.type === 'prometheus' || t.datasource?.type === 'prometheus')) targets.push({ title: panel.title, expr: t.expr }); for (const c of panel.panels || []) walk(c); };
      for (const panel of b.dashboard.panels || []) walk(panel);
      const sub = (e) => e.replace(/\$\{?__rate_interval\}?/g, '2m').replace(/\$\{?__interval\}?/g, '1m').replace(/\$\{?__range\}?/g, '1h').replace(/\$\{[a-zA-Z_]+:regex\}/g, '.*').replace(/\$[a-zA-Z_]+/g, '.*');
      let data = 0; const empties = [], errors = [];
      for (const t of targets) {
        const r = await query(sub(t.expr));
        if (r.body?.status !== 'success') errors.push(`${t.title}: ${r.body?.error || `HTTP ${r.status}`}`);
        else if (r.body.data.result.length) data++;
        else empties.push(t.title);
      }
      failures += errors.length;
      const uniq = (xs) => [...new Set(xs)];
      console.log(`${b.file}: ${targets.length} Prometheus targets, ${data} with data, ${empties.length} empty, ${errors.length} errors`);
      if (empties.length) console.log(`  empty: ${uniq(empties).join(' | ')}`);
      for (const e of uniq(errors)) console.log(`  ERROR ${e}`);
    }
  }
  console.log(failures ? `\n${failures} problem(s)` : '\nok: every loaded rule healthy, every panel expression valid');
  process.exit(failures ? 1 : 0);
}
