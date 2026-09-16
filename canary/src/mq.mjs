// Thin promise wrapper over the ibmmq MQI binding for the three roles.
import { readFileSync } from 'node:fs';
import mq from 'ibmmq';

export const MQC = mq.MQC;

export const cfg = {
  qmgr: process.env.MQ_QMGR || 'QM1',
  connName: process.env.MQ_CONNAME || 'localhost(1414)',
  channel: process.env.MQ_CHANNEL || 'DEV.APP.SVRCONN',
  user: process.env.MQ_USER || 'app',
  password: process.env.MQ_PASSWORD
    || (process.env.MQ_PASSWORD_FILE ? readFileSync(process.env.MQ_PASSWORD_FILE, 'utf8').trim() : 'passw0rd'),
};

export function connect() {
  const cno = new mq.MQCNO();
  cno.Options = MQC.MQCNO_CLIENT_BINDING | MQC.MQCNO_HANDLE_SHARE_BLOCK;
  const cd = new mq.MQCD();
  cd.ConnectionName = cfg.connName;
  cd.ChannelName = cfg.channel;
  cno.ClientConn = cd;
  const csp = new mq.MQCSP();
  csp.UserId = cfg.user;
  csp.Password = cfg.password;
  cno.SecurityParms = csp;
  return mq.ConnxPromise(cfg.qmgr, cno);
}

export function open(hConn, queue, options) {
  const od = new mq.MQOD();
  od.ObjectName = queue;
  od.ObjectType = MQC.MQOT_Q;
  return mq.OpenPromise(hConn, od, options);
}

export const OPEN_PUT = MQC.MQOO_OUTPUT | MQC.MQOO_FAIL_IF_QUIESCING;
export const OPEN_GET = MQC.MQOO_INPUT_AS_Q_DEF | MQC.MQOO_FAIL_IF_QUIESCING;
export const OPEN_BOTH = OPEN_PUT | OPEN_GET;

/** Put a message; returns the MQMD (MsgId filled in). */
export async function put(hObj, payload, { persistent = false } = {}) {
  const md = new mq.MQMD();
  md.Format = MQC.MQFMT_STRING;
  md.Persistence = persistent ? MQC.MQPER_PERSISTENT : MQC.MQPER_NOT_PERSISTENT;
  const pmo = new mq.MQPMO();
  pmo.Options = MQC.MQPMO_NO_SYNCPOINT | MQC.MQPMO_NEW_MSG_ID | MQC.MQPMO_NEW_CORREL_ID | MQC.MQPMO_FAIL_IF_QUIESCING;
  await mq.PutPromise(hObj, md, pmo, payload);
  return md;
}

/** Synchronous GET with wait; resolves {md, data} or null on MQRC_NO_MSG_AVAILABLE. */
export function get(hObj, { waitMs = 5000, matchMsgId = null, bufSize = 65536 } = {}) {
  return new Promise((resolve, reject) => {
    const md = new mq.MQMD();
    const gmo = new mq.MQGMO();
    // MQGMO_NO_PROPERTIES matters: the ibmmq OTel layer puts traceparent/tracestate on every
    // message as properties. With the queue default (PROPCTL COMPAT) an MQGET without a
    // message handle receives them as an MQRFH2 header prepended to the body (Format MQHRF2),
    // which broke the canary's payload comparison and would corrupt the orders JSON. With
    // NO_PROPERTIES the library swaps in its own handle (lib/mqiotel.js getTraceBefore), reads
    // the context for the consumer span link, and the application sees the clean body.
    gmo.Options = MQC.MQGMO_NO_SYNCPOINT | MQC.MQGMO_WAIT | MQC.MQGMO_CONVERT | MQC.MQGMO_FAIL_IF_QUIESCING | MQC.MQGMO_NO_PROPERTIES;
    gmo.WaitInterval = waitMs;
    if (matchMsgId) {
      gmo.MatchOptions = MQC.MQMO_MATCH_MSG_ID;
      md.MsgId = matchMsgId;
    } else {
      gmo.MatchOptions = MQC.MQMO_NONE;
    }
    const buf = Buffer.alloc(bufSize);
    mq.GetSync(hObj, md, gmo, buf, (err, len) => {
      if (err) {
        if (err.mqrc === MQC.MQRC_NO_MSG_AVAILABLE) return resolve(null);
        return reject(err);
      }
      resolve({ md, data: buf.subarray(0, len).toString() });
    });
  });
}

export async function close(hObj) { try { await mq.ClosePromise(hObj, 0); } catch { /* ignore */ } }
export async function disconnect(hConn) { try { await mq.DiscPromise(hConn); } catch { /* ignore */ } }

export const hex = (b) => Buffer.from(b).toString('hex');

/** Map an MQ error to a stable, low-cardinality result label. */
export function classify(err) {
  const rc = err?.mqrc;
  switch (rc) {
    case MQC.MQRC_Q_FULL: return 'put_failed_q_full';
    case MQC.MQRC_NO_MSG_AVAILABLE: return 'get_timeout';
    case MQC.MQRC_Q_MGR_NOT_AVAILABLE:
    case MQC.MQRC_HOST_NOT_AVAILABLE:
    case MQC.MQRC_CHANNEL_NOT_AVAILABLE:
    case MQC.MQRC_NOT_AUTHORIZED:
    case MQC.MQRC_CONNECTION_BROKEN:
    case MQC.MQRC_CONNECTION_QUIESCING:
    case MQC.MQRC_Q_MGR_QUIESCING:
    case MQC.MQRC_Q_MGR_STOPPING:
      return 'connect_failed';
    case MQC.MQRC_HCONN_ERROR:
    case MQC.MQRC_HOBJ_ERROR:
      return 'handle_invalid';
    default: return 'error';
  }
}

/** True when the connection itself is gone and must be re-established. */
export function needsReconnect(err) {
  const r = classify(err);
  return r === 'connect_failed' || r === 'handle_invalid';
}
