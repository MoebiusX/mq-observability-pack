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
const CANARY_EXPIRY_TENTHS = Number(process.env.CANARY_EXPIRY_TENTHS || 300);          // 30 s: a probe's message never outlives the next few probes
const CONSUMER_RECYCLE_EVERY = Number(process.env.CONSUMER_RECYCLE_EVERY || 5000);     // messages per MQ connection (see Session.recycle)
const { SpanKind, SpanStatusCode } = api;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- instruments -------------------------------------------------------------
const rtt = meter.createHistogram('mq.canary.roundtrip.duration', {
  description: 'Canary put→get round-trip time through the queue manager (connect time excluded)',
  unit: 's',
  advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] },
});
const attempts = meter.createCounter('mq.canary.attempts', { description: 'Canary round-trip attempts by result', unit: '{attempt}' });
const produced = meter.createCounter('mq.orders.produced', { description: 'Messages put to the orders queue', unit: '{message}' });
const consumed = meter.createCounter('mq.orders.consumed', { description: 'Messages got from the orders queue', unit: '{message}' });
const putErrors = meter.createCounter('mq.orders.put.errors', { description: 'Failed puts by MQ reason', unit: '{error}' });
const getErrors = meter.createCounter('mq.orders.get.errors', { description: 'Failed gets by MQ reason', unit: '{error}' });

const msgAttrs = (queue, op) => ({
  'messaging.system': 'ibmmq',
  'messaging.destination.name': queue,
  'messaging.operation.type': op,
  'server.address': MQ.cfg.connName,
});

// ---- connection lifecycle ----------------------------------------------------
class Session {
  constructor(queue, openOptions) { this.queue = queue; this.openOptions = openOptions; this.hConn = null; this.hObj = null; this.uses = 0; }
  async ensure() {
    if (this.hObj) return;
    if (this.hConn) { await MQ.disconnect(this.hConn); this.hConn = null; }   // never stack a new conversation on a half-open one
    this.hConn = await MQ.connect();
    try {
      this.hObj = await MQ.open(this.hConn, this.queue, this.openOptions);
    } catch (e) {
      // OPEN failed (2035 not authorised, 2085 unknown object, …): release the conversation,
      // otherwise every retry leaks one SVRCONN instance until the channel's limit is hit.
      await MQ.disconnect(this.hConn); this.hConn = null;
      throw e;
    }
    this.uses = 0;
    log('info', `connected ${MQ.cfg.qmgr} ${this.queue} via ${MQ.cfg.channel}@${MQ.cfg.connName}`);
  }
  async drop() {
    if (this.hObj) await MQ.close(this.hObj);
    if (this.hConn) await MQ.disconnect(this.hConn);
    this.hObj = null; this.hConn = null;
  }
  /**
   * Bounded connection lifetime. The ibmmq binding caches per-connection message handles
   * (released only at MQDISC) and the consumer's resident memory was measured growing ~1 KB
   * per GET; reconnecting every N messages caps whatever accumulates per conversation.
   */
  async recycle(every) {
    this.uses += 1;
    if (every > 0 && this.uses >= every) { log('info', `recycling MQ connection after ${this.uses} operations`, { queue: this.queue }); await this.drop(); }
  }
}
let active = null;   // the role's session, disconnected cleanly on SIGTERM

// ---- roles -------------------------------------------------------------------
async function canary() {
  const s = active = new Session(CANARY_QUEUE, MQ.OPEN_BOTH);
  let n = 0;
  for (;;) {
    n += 1;
    const payload = `canary-${new Date().toISOString()}-${n}`;
    let result = 'ok';
    let secs = 0;
    await tracer.startActiveSpan('canary roundtrip', { kind: SpanKind.INTERNAL, attributes: { 'mq.canary.seq': n } }, async (span) => {
      try {
        await s.ensure();
        const t0 = process.hrtime.bigint();   // the SLI is put→get through the queue manager, not connect time
        const md = await tracer.startActiveSpan(`${CANARY_QUEUE} publish`, { kind: SpanKind.PRODUCER, attributes: msgAttrs(CANARY_QUEUE, 'send') },
          async (ps) => { try { const m = await MQ.put(s.hObj, payload, { expiryTenths: CANARY_EXPIRY_TENTHS }); ps.setAttribute('messaging.message.id', MQ.hex(m.MsgId)); return m; } finally { ps.end(); } });
        const got = await tracer.startActiveSpan(`${CANARY_QUEUE} receive`, { kind: SpanKind.CONSUMER, attributes: msgAttrs(CANARY_QUEUE, 'receive') },
          async (cs) => { try { return await MQ.get(s.hObj, { waitMs: 5000, matchMsgId: md.MsgId }); } finally { cs.end(); } });
        secs = Number(process.hrtime.bigint() - t0) / 1e9;
        if (!got) result = 'get_timeout';
        else if (got.data !== payload) result = 'payload_mismatch';
      } catch (err) {
        result = MQ.classify(err);
        span.recordException(err);
        if (MQ.needsReconnect(err)) await s.drop();
      }
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
  const s = active = new Session(ORDERS_QUEUE, MQ.OPEN_PUT);
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
  const s = active = new Session(ORDERS_QUEUE, MQ.OPEN_GET);
  const workMs = Number(process.env.CONSUMER_WORK_MS || 20);
  let n = 0;
  for (;;) {
    try {
      await s.ensure();
    } catch (err) {
      log('warn', `connect failed: ${err.message}`, { mqrc: err.mqrc, reason: MQ.classify(err) }); await sleep(2000); continue;
    }
    // The CONSUMER span is active during the GET, so ibmmq's OTel hook links it to the
    // producer's traceparent carried in the message properties.
    await tracer.startActiveSpan(`${ORDERS_QUEUE} receive`, { kind: SpanKind.CONSUMER, attributes: msgAttrs(ORDERS_QUEUE, 'receive') }, async (span) => {
      try {
        const got = await MQ.get(s.hObj, { waitMs: 1000 });   // short wait: MQGET is synchronous and holds the event loop
        if (!got) { span.setAttribute('messaging.batch.message_count', 0); return; }
        n += 1;
        span.setAttribute('messaging.message.id', MQ.hex(got.md.MsgId));
        span.setAttribute('messaging.message.body.size', got.data.length);
        await tracer.startActiveSpan('process order', { kind: SpanKind.INTERNAL }, async (ws) => { await sleep(workMs); ws.end(); });
        consumed.add(1, { queue: ORDERS_QUEUE });
        if (n % 50 === 0) log('info', `consumed ${n} messages`, { queue: ORDERS_QUEUE });
        await s.recycle(CONSUMER_RECYCLE_EVERY);
      } catch (err) {
        const reason = MQ.classify(err);
        getErrors.add(1, { queue: ORDERS_QUEUE, reason, mqrc: String(err.mqrc ?? 'n/a') });
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
        log('warn', `get failed: ${err.message}`, { reason, mqrc: err.mqrc });
        if (MQ.needsReconnect(err)) { await s.drop(); await sleep(2000); }
        else if (reason === 'message_too_large') {
          // Remove the oversized message (it would otherwise stay at the head of the queue and
          // fail every subsequent GET); an order this size is a producer bug, log it loudly.
          try { const big = await MQ.get(s.hObj, { waitMs: 0, acceptTruncated: true }); log('error', 'discarded a message larger than the consumer buffer', { queue: ORDERS_QUEUE, msgId: big ? MQ.hex(big.md.MsgId) : null }); } catch (e2) { log('warn', `could not discard oversized message: ${e2.message}`); }
        }
        else await sleep(1000);   // never spin on a persistent error (GET(DISABLED), 2119, …)
      } finally { span.end(); }
    });
  }
}

// ---- main ----------------------------------------------------------------------
const roles = { canary, producer, consumer };
if (!roles[MODE]) { console.error(`unknown MODE=${MODE}`); process.exit(2); }
log('info', `starting role=${MODE}`, { qmgr: MQ.cfg.qmgr, connName: MQ.cfg.connName, channel: MQ.cfg.channel });
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  if (stopping) return; stopping = true;
  log('info', `${sig} received, disconnecting and flushing telemetry`);
  setTimeout(() => process.exit(0), 6000).unref();   // never outlive docker's stop grace period (10 s)
  try { if (active) await active.drop(); } catch { /* best effort */ }   // MQDISC, so the qmgr does not log AMQ9209E "connection closed"
  await shutdown(); process.exit(0);
});
roles[MODE]().catch(async (err) => { log('error', `role ${MODE} crashed: ${err.stack || err}`); await shutdown(); process.exit(1); });
