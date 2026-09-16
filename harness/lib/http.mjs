// HTTP helpers for the certification harness. Node ≥20, no deps.
export const cfg = {
  prom:    process.env.PROM_URL    || 'http://127.0.0.1:29090',
  am:      process.env.AM_URL      || 'http://127.0.0.1:29093',
  sink:    process.env.SINK_URL    || 'http://127.0.0.1:29095',
  loki:    process.env.LOKI_URL    || 'http://127.0.0.1:23100',
  tempo:   process.env.TEMPO_URL   || 'http://127.0.0.1:23200',
  grafana: process.env.GRAFANA_URL || 'http://127.0.0.1:23000',
  otelcol: process.env.OTELCOL_URL || 'http://127.0.0.1:23133',
  grafanaAuth: 'Basic ' + Buffer.from(process.env.GRAFANA_AUTH || 'admin:admin').toString('base64'),
};

export async function getJSON(url, { headers = {}, timeoutMs = 10000, method = 'GET' } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, method, signal: ctl.signal });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: String(e) };
  } finally { clearTimeout(t); }
}

export async function ping(url, timeoutMs = 5000) {
  const r = await getJSON(url, { timeoutMs });
  return r.status >= 200 && r.status < 400;
}

/** Instant PromQL query → array of {metric, value:[ts, "v"]} (empty on error). */
export async function promQuery(expr, at) {
  const u = new URL('/api/v1/query', cfg.prom);
  u.searchParams.set('query', expr);
  if (at) u.searchParams.set('time', String(at));
  const r = await getJSON(u);
  if (!r.ok || r.body?.status !== 'success') return { ok: false, error: r.body?.error || r.body, result: [] };
  return { ok: true, result: r.body.data.result || [], resultType: r.body.data.resultType };
}

export const scalar = (q) => (q.ok && q.result.length ? Number(q.result[0].value[1]) : NaN);

export async function promRules() {
  const r = await getJSON(new URL('/api/v1/rules', cfg.prom));
  if (!r.ok) return [];
  return (r.body.data?.groups || []).flatMap(g => g.rules.map(rule => ({ ...rule, group: g.name })));
}

export async function promTargets() {
  const r = await getJSON(new URL('/api/v1/targets', cfg.prom));
  return r.ok ? (r.body.data?.activeTargets || []) : [];
}

export async function amAlerts() {
  const r = await getJSON(new URL('/api/v2/alerts', cfg.am));
  return r.ok && Array.isArray(r.body) ? r.body : [];
}

export async function sinkEvents({ since = 0, alertname } = {}) {
  const u = new URL('/events', cfg.sink);
  if (since) u.searchParams.set('since', String(since));
  if (alertname) u.searchParams.set('alertname', alertname);
  const r = await getJSON(u);
  return r.ok && Array.isArray(r.body) ? r.body : [];
}

export async function lokiQuery(query, { minutes = 15, limit = 50 } = {}) {
  const u = new URL('/loki/api/v1/query_range', cfg.loki);
  const end = Date.now() * 1e6;
  u.searchParams.set('query', query);
  u.searchParams.set('start', String(end - minutes * 60 * 1e9));
  u.searchParams.set('end', String(end));
  u.searchParams.set('limit', String(limit));
  const r = await getJSON(u);
  if (!r.ok || r.body?.status !== 'success') return { ok: false, error: r.body?.error || r.body, streams: [] };
  return { ok: true, streams: r.body.data.result || [] };
}

/** Tempo: distinct resource.service.name values (v2 tag-values API; v1 shape tolerated). */
export async function tempoServices() {
  const r = await getJSON(new URL('/api/v2/search/tag/resource.service.name/values', cfg.tempo));
  if (!r.ok) return [];
  return (r.body.tagValues || []).map(v => (typeof v === 'string' ? v : v?.value)).filter(Boolean);
}

/**
 * Tempo: TraceQL search → trace IDs → each trace as OTLP JSON.
 * Returns [{ traceID, resourceSpans }]. Span/trace IDs inside the OTLP JSON are proto-JSON
 * encoded (base64); compare them with each other, not with the hex traceID.
 */
export async function tempoTraces(traceql, { limit = 20, lookbackSec = 3600 } = {}) {
  const end = Math.floor(Date.now() / 1000), start = end - lookbackSec;
  const u = new URL('/api/search', cfg.tempo);
  u.searchParams.set('q', traceql);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('start', String(start));
  u.searchParams.set('end', String(end));
  const r = await getJSON(u, { timeoutMs: 20000 });
  const ids = r.ok ? (r.body.traces || []).map(t => t.traceID).filter(Boolean) : [];
  const out = [];
  for (const id of ids) {
    const t = await getJSON(new URL(`/api/v2/traces/${id}`, cfg.tempo), { timeoutMs: 20000 });
    if (!t.ok) continue;
    const body = t.body?.trace || t.body || {};
    out.push({ traceID: id, resourceSpans: body.resourceSpans || body.batches || [] });
  }
  return out;
}

export async function grafana(path) {
  return getJSON(new URL(path, cfg.grafana), { headers: { authorization: cfg.grafanaAuth } });
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Poll `fn` until it returns a truthy value or timeout; returns {value, elapsedMs}. */
export async function waitFor(fn, { timeoutMs = 120000, intervalMs = 2000, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return { value: v, elapsedMs: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { value: null, elapsedMs: Date.now() - t0, timedOut: true, label };
    await sleep(intervalMs);
  }
}
