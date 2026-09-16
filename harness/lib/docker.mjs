// docker compose + runmqsc helpers. The harness runs on the host next to the compose file.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const composeBin = (process.env.COMPOSE || 'docker compose').split(' ');
const qmgr = mqName(process.env.MQ_QMGR_NAME || 'QM1', 'MQ_QMGR_NAME');

/** MQ object names: letters, digits, . / _ % — anything else never reaches a shell. */
function mqName(s, what) {
  if (!/^[A-Za-z0-9._%/]{1,48}$/.test(String(s))) throw new Error(`invalid MQ name for ${what}: ${JSON.stringify(s)}`);
  return String(s);
}

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
 * stopped). runmqsc's trailer says how many commands failed; a failed command is an error
 * here unless every problem it reported is in `tolerate` (message-id prefixes such as
 * AMQ8420 "Channel Status not found", which DIS CHSTATUS returns for an idle channel).
 * Success and error ids both start with AMQ8, so the id alone never decides.
 */
export async function runmqsc(commands, { tolerate = ['AMQ8420'] } = {}) {
  const script = (Array.isArray(commands) ? commands : [commands]).join('\n') + '\n';
  let stdout;
  try {
    ({ stdout } = await compose('exec', '-T', 'mq', 'bash', '-lc', `printf '%s' ${shellQuote(script)} | runmqsc ${qmgr}`));
  } catch (e) {
    if (!(e && typeof e.stdout === 'string' && /MQSC command/.test(e.stdout))) throw e;   // docker itself failed
    stdout = e.stdout;
  }
  const failed = countFailed(stdout);
  if (failed > 0) {
    const problems = [...new Set([...stdout.matchAll(/\b(AMQ\d{4})[EW]\b|\b(AMQ8420)I\b/g)].map(m => m[1] || m[2]))];
    const tolerated = problems.length > 0 && problems.every(p => tolerate.includes(p));
    if (!tolerated) {
      const err = new Error(`runmqsc: ${failed} command(s) failed [${problems.join(', ') || 'no message id'}]: ${stdout.trim().split('\n').filter(l => /AMQ\d{4}[EW]|could not be processed|syntax error/.test(l)).slice(0, 4).join(' | ')}`);
      err.stdout = stdout;
      throw err;
    }
  }
  return stdout;
}

/** Number of commands runmqsc could not process (syntax errors included). */
function countFailed(out) {
  const n = (re) => { const m = re.exec(out); return m ? (m[1] === 'One' ? 1 : Number(m[1])) : 0; };
  return n(/(\d+|One) valid MQSC commands? could not be processed/) + n(/(\d+|One) commands? (?:has|have) a syntax error/);
}

/** Put `count` messages on a queue using the MQ sample amqsput (local bindings). */
export async function amqsput(queue, lines) {
  const q = mqName(queue, 'queue');
  const payload = lines.join('\n') + '\n';
  const { stdout } = await compose('exec', '-T', 'mq', 'bash', '-lc', `printf '%s' ${shellQuote(payload)} | /opt/mqm/samp/bin/amqsput ${q} ${qmgr}`);
  return stdout;
}

/** Drain a queue with amqsget (returns after its 15 s no-message wait). */
export async function amqsget(queue) {
  const q = mqName(queue, 'queue');
  const { stdout } = await compose('exec', '-T', 'mq', 'bash', '-lc', `/opt/mqm/samp/bin/amqsget ${q} ${qmgr}`);
  return stdout;
}

function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
