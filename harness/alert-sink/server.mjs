// alert-sink — Alertmanager webhook ledger for the certification harness.
// Zero dependencies. Every webhook is flattened to one event per alert with the
// wall-clock time it was RECEIVED (that is the MTTD end-point, not Alertmanager's startsAt).
import { createServer } from 'node:http';

const events = [];
const port = Number(process.env.PORT || 9095);

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, events: events.length });
  if (req.method === 'GET' && url.pathname === '/events') {
    const since = Number(url.searchParams.get('since') || 0);
    const name = url.searchParams.get('alertname');
    return json(res, 200, events.filter(e => e.receivedAt >= since && (!name || e.alertname === name)));
  }
  if (req.method === 'DELETE' && url.pathname === '/events') { events.length = 0; return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/webhook') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const receivedAt = Date.now();
        for (const a of payload.alerts || []) {
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
