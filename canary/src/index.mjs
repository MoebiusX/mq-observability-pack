// mq-obs canary — three roles selected by MODE:
//   canary   : put/get round-trip on APP.CANARY every INTERVAL_MS; histogram + result counter
//   producer : RATE_PER_SEC persistent puts to APP.ORDERS.REQ, one PRODUCER span each
//   consumer : blocking gets from APP.ORDERS.REQ, one CONSUMER span each (linked to producer ctx)
import { api, tracer, meter, log, shutdown } from './otel.mjs';   // must precede ./mq.mjs
import * as MQ from './mq.mjs';

const MODE = process.env.MODE || 'canary';
const CANARY_QUEUE = process.env.CANARY_QUEUE || 'APP.CANARY';
const ORDERS_QUEUE = process.env.ORDERS_QUEUE || 'APP.ORDERS.REQ';
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 10000);
const RATE_PER_SEC = Number(process.env.RATE_PER_SEC || 5);
const { SpanKind, SpanStatusCode } = api;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- instruments -------------------------------------------------------------
const rtt = meter.createHistogram('mq.canary.roundtrip.duration', {
  description: 'Canary put→get round-trip time through the queue manager',
  unit: 's',
  advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] },
});
const attempts = meter.createCounter('mq.canary.attempts', { description: 'Canary round-trip attempts by result', unit: '{attempt}' });
const produced = meter.createCounter('mq.orders.produced', { description: 'Messages put to the orders queue', unit: '{message}' });
const consumed = meter.createCounter('mq.orders.consumed', { description: 'Messages got from the orders queue', unit: '{message}' });
const putErrors = meter.createCounter('mq.orders.put.errors', { description: 'Failed puts by MQ reason', unit: '{error}' });

const msgAttrs = (queue, op) => ({
  'messaging.system': 'ibmmq',
  'messaging.destination.name': queue,
  'messaging.operation.type': op,
  'server.address': MQ.cfg.connName,
});

// ---- connection lifecycle ----------------------------------------------------
class Session {
  constructor(queue, openOptions) { this.queue = queue; this.openOptions = openOptions; this.hConn = null; this.hObj = null; }
  async ensure() {
    if (this.hObj) return;
    this.hConn = await MQ.connect();
    this.hObj = await MQ.open(this.hConn, this.queue, this.openOptions);
    log('info', `connected ${MQ.cfg.qmgr} ${this.queue} via ${MQ.cfg.channel}@${MQ.cfg.connName}`);
  }
  async drop() {
    if (this.hObj) await MQ.close(this.hObj);
    if (this.hConn) await MQ.disconnect(this.hConn);
    this.hObj = null; this.hConn = null;
  }
}

// ---- roles -------------------------------------------------------------------
async function canary() {
  const s = new Session(CANARY_QUEUE, MQ.OPEN_BOTH);
  let n = 0;
  for (;;) {
    n += 1;
    const payload = `canary-${new Date().toISOString()}-${n}`;
    const t0 = process.hrtime.bigint();
    let result = 'ok';
    await tracer.startActiveSpan('canary roundtrip', { kind: SpanKind.INTERNAL, attributes: { 'mq.canary.seq': n } }, async (span) => {
      try {
        await s.ensure();
        const md = await tracer.startActiveSpan(`${CANARY_QUEUE} publish`, { kind: SpanKind.PRODUCER, attributes: msgAttrs(CANARY_QUEUE, 'send') },
          async (ps) => { try { const m = await MQ.put(s.hObj, payload); ps.setAttribute('messaging.message.id', MQ.hex(m.MsgId)); return m; } finally { ps.end(); } });
        const got = await tracer.startActiveSpan(`${CANARY_QUEUE} receive`, { kind: SpanKind.CONSUMER, attributes: msgAttrs(CANARY_QUEUE, 'receive') },
          async (cs) => { try { return await MQ.get(s.hObj, { waitMs: 5000, matchMsgId: md.MsgId }); } finally { cs.end(); } });
        if (!got) result = 'get_timeout';
        else if (got.data !== payload) result = 'payload_mismatch';
      } catch (err) {
        result = MQ.classify(err);
        span.recordException(err);
        if (MQ.needsReconnect(err)) await s.drop();
      }
      const secs = Number(process.hrtime.bigint() - t0) / 1e9;
      rtt.record(secs, { result });
      attempts.add(1, { result });
      span.setAttribute('mq.canary.result', result);
      span.setStatus({ code: result === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR, message: result });
      log(result === 'ok' ? 'info' : 'warn', `canary ${result} in ${(secs * 1000).toFixed(1)}ms`, { result, seq: n });
      span.end();
    });
    await sleep(INTERVAL_MS);
  }
}

async function producer() {
  const s = new Session(ORDERS_QUEUE, MQ.OPEN_PUT);
  const gap = 1000 / Math.max(RATE_PER_SEC, 0.001);
  let n = 0;
  for (;;) {
    n += 1;
    const order = JSON.stringify({ orderId: `ord-${Date.now()}-${n}`, symbol: 'BTC-EUR', qty: 0.01, ts: new Date().toISOString() });
    await tracer.startActiveSpan(`${ORDERS_QUEUE} publish`, { kind: SpanKind.PRODUCER, attributes: msgAttrs(ORDERS_QUEUE, 'send') }, async (span) => {
      try {
        await s.ensure();
        const md = await MQ.put(s.hObj, order, { persistent: true });
        span.setAttribute('messaging.message.id', MQ.hex(md.MsgId));
        produced.add(1, { queue: ORDERS_QUEUE });
        if (n % 50 === 0) log('info', `produced ${n} messages`, { queue: ORDERS_QUEUE });
      } catch (err) {
        const reason = MQ.classify(err);
        putErrors.add(1, { queue: ORDERS_QUEUE, reason, mqrc: String(err.mqrc ?? 'n/a') });
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
        log('warn', `put failed: ${err.message}`, { reason, mqrc: err.mqrc });
        if (MQ.needsReconnect(err)) { await s.drop(); await sleep(2000); }
        else await sleep(1000);
      } finally { span.end(); }
    });
    await sleep(gap);
  }
}

async function consumer() {
  const s = new Session(ORDERS_QUEUE, MQ.OPEN_GET);
  const workMs = Number(process.env.CONSUMER_WORK_MS || 20);
  let n = 0;
  for (;;) {
    try {
      await s.ensure();
    } catch (err) {
      log('warn', `connect failed: ${err.message}`, { mqrc: err.mqrc }); await sleep(2000); continue;
    }
    // The CONSUMER span is active during the GET, so ibmmq's OTel hook links it to the
    // producer's traceparent carried in the message properties.
    await tracer.startActiveSpan(`${ORDERS_QUEUE} receive`, { kind: SpanKind.CONSUMER, attributes: msgAttrs(ORDERS_QUEUE, 'receive') }, async (span) => {
      try {
        const got = await MQ.get(s.hObj, { waitMs: 5000 });
        if (!got) { span.setAttribute('messaging.batch.message_count', 0); return; }
        n += 1;
        span.setAttribute('messaging.message.id', MQ.hex(got.md.MsgId));
        span.setAttribute('messaging.message.body.size', got.data.length);
        await tracer.startActiveSpan('process order', { kind: SpanKind.INTERNAL }, async (ws) => { await sleep(workMs); ws.end(); });
        consumed.add(1, { queue: ORDERS_QUEUE });
        if (n % 50 === 0) log('info', `consumed ${n} messages`, { queue: ORDERS_QUEUE });
      } catch (err) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: MQ.classify(err) });
        log('warn', `get failed: ${err.message}`, { mqrc: err.mqrc });
        if (MQ.needsReconnect(err)) { await s.drop(); await sleep(2000); }
      } finally { span.end(); }
    });
  }
}

// ---- main ----------------------------------------------------------------------
const roles = { canary, producer, consumer };
if (!roles[MODE]) { console.error(`unknown MODE=${MODE}`); process.exit(2); }
log('info', `starting role=${MODE}`, { qmgr: MQ.cfg.qmgr, connName: MQ.cfg.connName, channel: MQ.cfg.channel });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  log('info', `${sig} received, flushing telemetry`);
  setTimeout(() => process.exit(0), 4000).unref();   // never outlive docker's stop grace period
  await shutdown(); process.exit(0);
});
roles[MODE]().catch(async (err) => { log('error', `role ${MODE} crashed: ${err.stack || err}`); await shutdown(); process.exit(1); });
