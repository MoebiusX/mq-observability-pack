#!/usr/bin/env node
// Runs every query of every generated dashboard against the LIVE stack and reports the
// panels whose targets error or return nothing. A dashboard panel that renders "No data"
// is a broken promise; this catches it before a human opens Grafana.
//
//   node tools/verify-dashboards.mjs                 # all of stack/grafana/dashboards/*.json
//   node tools/verify-dashboards.mjs stack/grafana/dashboards/ibmmq-unified.json
//   node tools/verify-dashboards.mjs --strict        # empties fail too
//
// What counts as broken (each one was a blind spot once):
//   * a Prometheus target that errors, or returns nothing (instant query at now AND a
//     range query over the dashboard's default window, so a range-only failure shows);
//   * a target whose `or vector(0)` fallback is the only thing answering — the metric it
//     names may not exist at all ("MASKED"); reported separately, fails with --strict;
//   * a Loki target whose streams carry __error__ (a pipeline stage such as `| json` failing
//     on the stored lines is an error, not data);
//   * a Tempo search with no traces.
// Template variables are expanded to "everything" ($queue → .*, ${service:regex} → the four
// MQ services, $__range → the dashboard window). Panels nested under rows are walked. The
// run refuses to conclude while a symptom alert is firing (the lab is mid-incident; empties
// would be meaningless) unless --allow-firing is given.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prom = process.env.PROM_URL || 'http://127.0.0.1:29090';
const loki = process.env.LOKI_URL || 'http://127.0.0.1:23100';
const tempo = process.env.TEMPO_URL || 'http://127.0.0.1:23200';
const strict = process.argv.includes('--strict');
const allowFiring = process.argv.includes('--allow-firing');
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
const targets = files.length ? files : readdirSync(resolve(root, 'stack/grafana/dashboards')).filter(f => f.endsWith('.json')).map(f => `stack/grafana/dashboards/${f}`);
const SERVICES = 'ibmmq|mq-canary|orders-producer|orders-consumer';

async function json(url) { const r = await fetch(url); return r.json(); }
const rangeSec = (d) => { const m = /^now-(\d+)([smhd])$/.exec(d?.time?.from || ''); return m ? Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]] : 3600; };

async function promInstant(expr) { const u = new URL('/api/v1/query', prom); u.searchParams.set('query', expr); return json(u); }
async function promRange(expr, sec) {
  const u = new URL('/api/v1/query_range', prom); const end = Math.floor(Date.now() / 1000);
  for (const [k, v] of Object.entries({ query: expr, start: end - sec, end, step: Math.max(15, Math.floor(sec / 200)) })) u.searchParams.set(k, String(v));
  return json(u);
}

const firing = await promInstant('ALERTS{pack="ibmmq", alertstate="firing", burn_rate="", kind=""}').catch(() => ({ data: { result: [] } }));
const firingNames = [...new Set((firing.data?.result || []).map(r => r.metric.alertname))];
if (firingNames.length && !allowFiring) {
  console.error(`symptom alert(s) firing (${firingNames.join(', ')}): the lab is mid-incident, panel emptiness is meaningless now. Re-run when clear, or pass --allow-firing.`);
  process.exit(2);
}

let failed = false;
for (const file of targets) {
  const d = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
  const sec = rangeSec(d);
  const sub = (e) => String(e).replace(/\$queue/g, '.*').replace(/\$\{service:regex\}/g, SERVICES).replace(/\$__range/g, `${sec}s`).replace(/\$__rate_interval/g, '1m').replace(/\$__interval/g, '1m');
  let ok = 0; const empty = [], masked = [], errors = [];
  const panels = (d.panels || []).flatMap(p => [p, ...(p.panels || [])]);
  for (const p of panels) {
    if (p.type === 'row') continue;
    const dsType = p.datasource?.type || 'prometheus';
    for (const t of p.targets || []) {
      if (t.hide) continue;
      const label = `${p.title} [${t.refId}]`;
      try {
        if (dsType === 'prometheus') {
          if (!t.expr) { errors.push(`${label}: prometheus target without expr`); continue; }
          const expr = sub(t.expr);
          const inst = await promInstant(expr);
          if (inst.status !== 'success') { errors.push(`${label}: ${inst.error}`); continue; }
          let rng = null;
          if (!t.instant) { rng = await promRange(expr, sec); if (rng.status !== 'success') { errors.push(`${label}: range: ${rng.error}`); continue; } }
          const instEmpty = !inst.data.result.length, rngEmpty = rng ? !rng.data.result.length : false;
          if (instEmpty || rngEmpty) { empty.push(`${label}: ${expr.slice(0, 120)}${rngEmpty && !instEmpty ? ' (range empty)' : ''}`); continue; }
          // `or vector(0)`: ask the same question without the fallback; if nothing answers, the
          // metric name may simply not exist and the panel would happily show 0 forever.
          if (/\bor\s+vector\(0\)/.test(expr)) {
            const bare = expr.replace(/\s*\bor\s+vector\(0\)/g, '');
            const b = await promInstant(bare);
            if (b.status === 'success' && !b.data.result.length) { masked.push(`${label}: only the vector(0) fallback answers: ${bare.slice(0, 100)}`); continue; }
          }
          ok++;
        } else if (dsType === 'loki') {
          const end = Date.now() * 1e6, start = end - Math.min(sec, 3600) * 1e9;
          const u = new URL('/loki/api/v1/query_range', loki);
          for (const [k, v] of Object.entries({ query: sub(t.expr), start, end, limit: '20' })) u.searchParams.set(k, String(v));
          const j = await json(u);
          if (j.status !== 'success') { errors.push(`${label}: ${JSON.stringify(j).slice(0, 120)}`); continue; }
          const streams = j.data.result;
          const errStreams = streams.filter(s => s.stream?.__error__);
          if (errStreams.length) { errors.push(`${label}: ${errStreams.length}/${streams.length} streams carry __error__=${errStreams[0].stream.__error__} (${(errStreams[0].stream.__error_details__ || '').slice(0, 60)})`); continue; }
          if (!streams.length) { empty.push(`${label}: ${sub(t.expr)}`); continue; }
          ok++;
        } else if (dsType === 'tempo') {
          const end = Math.floor(Date.now() / 1000), start = end - Math.min(sec, 3600);
          const u = new URL('/api/search', tempo);
          for (const [k, v] of Object.entries({ q: t.query, limit: '5', start, end })) u.searchParams.set(k, String(v));
          const j = await json(u);
          if (!j.traces) { errors.push(`${label}: ${JSON.stringify(j).slice(0, 120)}`); continue; }
          if (!j.traces.length) { empty.push(`${label}: ${t.query}`); continue; }
          ok++;
        } else errors.push(`${label}: unknown datasource type ${dsType}`);
      } catch (e) { errors.push(`${label}: ${e.message}`); }
    }
  }
  // template variables: their queries must answer too
  for (const v of d.templating?.list || []) {
    try {
      if (v.datasource?.type === 'loki') { const j = await json(new URL(`/loki/api/v1/label/${v.query?.label}/values`, loki)); if (!j.data?.length) empty.push(`variable ${v.name}: no label values`); else ok++; }
      else if (v.type === 'query') { const m = /label_values\((.+),\s*(\w+)\)/.exec(v.definition || ''); if (m) { const j = await promInstant(`count by (${m[2]})(${m[1]})`); if (!j.data?.result?.length) empty.push(`variable ${v.name}: ${v.definition}`); else ok++; } }
    } catch (e) { errors.push(`variable ${v.name}: ${e.message}`); }
  }
  console.log(`${file}: ${ok} queries return data, ${empty.length} empty, ${masked.length} masked by vector(0), ${errors.length} errors`);
  for (const e of errors) console.log('  ERROR  ', e);
  for (const e of masked) console.log('  MASKED ', e);
  for (const e of empty) console.log('  EMPTY  ', e);
  if (errors.length || (strict && (empty.length || masked.length))) failed = true;
}
if (firingNames.length) console.log(`note: run with --allow-firing while ${firingNames.join(', ')} fired; empties may be incident effects`);
process.exit(failed ? 1 : 0);
