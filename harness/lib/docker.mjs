// docker compose + runmqsc helpers. The harness runs on the host next to the compose file.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const composeBin = (process.env.COMPOSE || 'docker compose').split(' ');
const qmgr = process.env.MQ_QMGR_NAME || 'QM1';

export async function compose(...args) {
  const [bin, ...pre] = composeBin;
  const { stdout, stderr } = await pexec(bin, [...pre, ...args], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return { stdout, stderr };
}

export async function composePs() {
  try {
    const { stdout } = await compose('ps', '--format', 'json');
    // docker compose v2 prints one JSON object per line (or an array on older builds)
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) return JSON.parse(trimmed);
    return trimmed.split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

export async function composeImages() {
  try {
    const { stdout } = await compose('images', '--format', 'json');
    const t = stdout.trim();
    if (!t) return [];
    return t.startsWith('[') ? JSON.parse(t) : t.split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

export const stop  = (svc) => compose('stop', svc);
export const start = (svc) => compose('start', svc);

/**
 * Run MQSC commands inside the mq container (local bindings — works even with the listener
 * stopped). runmqsc exits non-zero when any command reports a problem (e.g. STOP CHANNEL on a
 * channel with no active instance, AMQ8420); the remaining commands still ran, so the output
 * is returned instead of throwing and callers judge the effect through the alerts.
 */
export async function runmqsc(commands) {
  const script = (Array.isArray(commands) ? commands : [commands]).join('\n') + '\n';
  try {
    const { stdout } = await compose('exec', '-T', 'mq', 'bash', '-lc', `printf '%s' ${shellQuote(script)} | runmqsc ${qmgr}`);
    return stdout;
  } catch (e) {
    if (e && typeof e.stdout === 'string' && e.stdout.includes('AMQ8')) return e.stdout;
    throw e;
  }
}

/** Put `count` messages on a queue using the MQ sample amqsput (local bindings). */
export async function amqsput(queue, lines) {
  const payload = lines.join('\n') + '\n';
  const { stdout } = await compose('exec', '-T', 'mq', 'bash', '-lc', `printf '%s' ${shellQuote(payload)} | /opt/mqm/samp/bin/amqsput ${queue} ${qmgr}`);
  return stdout;
}

/** Drain a queue with amqsget (returns after its 15 s no-message wait). */
export async function amqsget(queue) {
  const { stdout } = await compose('exec', '-T', 'mq', 'bash', '-lc', `/opt/mqm/samp/bin/amqsget ${queue} ${qmgr}`);
  return stdout;
}

function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
