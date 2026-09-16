// alert-sink — Alertmanager webhook ledger for the certification harness.
// Zero dependencies. Every webhook is flattened to one event per alert with the
// wall-clock time it was RECEIVED (that is the MTTD end-point, not Alertmanager's startsAt).
import { createServer } from 'node:http';

const events = [];
const port = Number(process.env.PORT || 9095);
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 20000);     // ring buffer: repeat_interval re-sends long burns hourly
const MAX_BODY = 1024 * 1024;                                    // an Alertmanager webhook is a few KB; refuse anything absurd

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // `now` lets the harness stamp fault injection on the same clock as receivedAt (no host/VM skew).
  if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, events: events.length, now: Date.now() });
  if (req.method === 'GET' && url.pathname === '/events') {
    const since = Number(url.searchParams.get('since') || 0);
    const name = url.searchParams.get('alertname');
    return json(res, 200, events.filter(e => e.receivedAt >= since && (!name || e.alertname === name)));
  }
  if (req.method === 'DELETE' && url.pathname === '/events') { events.length = 0; return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/webhook') {
    let body = '', size = 0, tooLarge = false;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { tooLarge = true; req.destroy(); return; } body += c; });
    req.on('close', () => { if (tooLarge && !res.headersSent) json(res, 413, { error: 'body too large' }); });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const payload = JSON.parse(body || '{}');
        const receivedAt = Date.now();
        for (const a of payload.alerts || []) {
          if (events.length >= MAX_EVENTS) events.shift();
          events.push({
            receivedAt,
            status: a.status,
            alertname: a.labels?.alertname,
            labels: a.labels || {},
            annotations: a.annotations || {},
            startsAt: a.startsAt,
            endsAt: a.endsAt,
            fingerprint: a.fingerprint,
          });
        }
        process.stdout.write(`${new Date(receivedAt).toISOString()} ${payload.status} ${(payload.alerts || []).map(a => a.labels?.alertname).join(',')}\n`);
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: String(e) }); }
    });
    return;
  }
  json(res, 404, { error: 'not found' });
}).listen(port, () => process.stdout.write(`alert-sink listening on :${port}\n`));
