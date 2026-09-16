#!/usr/bin/env node
// Runs every query of every generated dashboard against the LIVE stack and reports the
// panels whose targets error or return nothing. A dashboard panel that renders "No data"
// is a broken promise; this catches it before a human opens Grafana.
//
//   node tools/verify-dashboards.mjs                 # all of stack/grafana/dashboards/*.json
//   node tools/verify-dashboards.mjs stack/grafana/dashboards/ibmmq-unified.json
//
// Template variables are expanded to "everything" ($queue → .*, ${service:regex} → all lab
// services, $__range → 1h). Exit code 1 on any error; empties are listed but do not fail
// (some series are legitimately empty, e.g. the forecast-alert state while none is pending),
// unless --strict is given. Endpoints follow the harness defaults (PROM_URL, LOKI_URL, TEMPO_URL).
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prom = process.env.PROM_URL || 'http://127.0.0.1:29090';
const loki = process.env.LOKI_URL || 'http://127.0.0.1:23100';
const tempo = process.env.TEMPO_URL || 'http://127.0.0.1:23200';
const strict = process.argv.includes('--strict');
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
const targets = files.length ? files : readdirSync(resolve(root, 'stack/grafana/dashboards')).filter(f => f.endsWith('.json')).map(f => `stack/grafana/dashboards/${f}`);
const sub = (e) => String(e).replace(/\$queue/g, '.*').replace(/\$\{service:regex\}/g, 'ibmmq|mq-canary|orders-producer|orders-consumer').replace(/\$__range/g, '1h').replace(/\$__rate_interval/g, '1m');

async function json(url) { const r = await fetch(url); return r.json(); }
let failed = false;
for (const file of targets) {
  const d = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
  let ok = 0; const empty = [], errors = [];
  for (const p of d.panels || []) {
    if (p.type === 'row') continue;
    const dsType = p.datasource?.type || 'prometheus';
    for (const t of p.targets || []) {
      const label = `${p.title} [${t.refId}]`;
      try {
        if (dsType === 'prometheus') {
          const u = new URL('/api/v1/query', prom); u.searchParams.set('query', sub(t.expr));
          const j = await json(u);
          if (j.status !== 'success') errors.push(`${label}: ${j.error}`);
          else if (!j.data.result.length) empty.push(`${label}: ${sub(t.expr).slice(0, 120)}`);
          else ok++;
        } else if (dsType === 'loki') {
          const end = Date.now() * 1e6, start = end - 30 * 60e9;
          const u = new URL('/loki/api/v1/query_range', loki);
          for (const [k, v] of Object.entries({ query: sub(t.expr), start, end, limit: '5' })) u.searchParams.set(k, String(v));
          const j = await json(u);
          if (j.status !== 'success') errors.push(`${label}: ${JSON.stringify(j).slice(0, 120)}`);
          else if (!j.data.result.length) empty.push(`${label}: ${sub(t.expr)}`); else ok++;
        } else if (dsType === 'tempo') {
          const end = Math.floor(Date.now() / 1000), start = end - 1800;
          const u = new URL('/api/search', tempo);
          for (const [k, v] of Object.entries({ q: t.query, limit: '5', start, end })) u.searchParams.set(k, String(v));
          const j = await json(u);
          if (!j.traces) errors.push(`${label}: ${JSON.stringify(j).slice(0, 120)}`);
          else if (!j.traces.length) empty.push(`${label}: ${t.query}`); else ok++;
        }
      } catch (e) { errors.push(`${label}: ${e.message}`); }
    }
  }
  console.log(`${file}: ${ok} queries return data, ${empty.length} empty, ${errors.length} errors`);
  for (const e of errors) console.log('  ERROR ', e);
  for (const e of empty) console.log('  EMPTY ', e);
  if (errors.length || (strict && empty.length)) failed = true;
}
process.exit(failed ? 1 : 0);
