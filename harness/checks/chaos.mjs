// Chaos: execute every pack chaos_experiment with a docker-level fault, measure MTTD
// (alert-sink receivedAt − injection timestamp) against expected_mttd, then recover
// and confirm the alerts resolve. Real faults, real alerts, real timestamps.
//
// Safety contract (learned the hard way: a run killed mid-hold left the listener and both
// SVRCONN channels stopped until someone noticed):
//   * recover() always runs once inject() was attempted (try/finally);
//   * SIGINT/SIGTERM recover the in-flight experiment before exiting 130;
//   * every fault has a clean() probe; the suite refuses to inject on a dirty lab and
//     `node harness/run.mjs --recover` runs every fault's recover() to repair it;
//   * a SIGKILL (tool timeout, OOM) cannot be intercepted — that is what --recover is for.
import { stop, start, runmqsc, amqsput, amqsget, composePs } from '../lib/docker.mjs';
import { cfg, getJSON, promQuery, sinkEvents, waitFor, sleep } from '../lib/http.mjs';
import { durationToMs, sliExpr } from '../lib/pack.mjs';

/**
 * MTTD end-points are the alert-sink's receivedAt stamps, so injection/recovery instants are
 * read from the sink's clock too (its /healthz returns `now`). Mixing in the host clock would
 * expose MTTD to Windows ↔ Docker Desktop VM (WSL2) clock drift. No silent fallback: if the
 * sink cannot be read the experiment is aborted rather than measured on the wrong clock.
 */
async function sinkNow() {
  let last = null;
  for (let i = 0; i < 5; i++) {
    const r = await getJSON(new URL('/healthz', cfg.sink));
    const n = Number(r.body?.now);
    if (r.ok && Number.isFinite(n) && n > 0) return n;
    last = r.status;
    await sleep(1000);
  }
  throw new Error(`alert-sink /healthz unavailable (last status ${last}); refusing to time the experiment on the host clock`);
}

const LISTENER = 'SYSTEM.LISTENER.TCP.1';
const SVRCONNS = ['DEV.APP.SVRCONN', 'DEV.ADMIN.SVRCONN'];

/**
 * Fault implementations, keyed by pack chaos_experiment id.
 *   inject(exp)  – apply the fault
 *   recover(exp) – undo it (idempotent: safe to call on a healthy lab)
 *   clean(exp)   – null when the lab shows no trace of this fault, else a short description
 */
const faults = {
  'qmgr-down': {
    inject: () => stop('mq'),
    recover: async () => {
      await start('mq');
      const h = await waitHealthy('mq', 180000);
      if (h.timedOut) throw new Error('mq did not report healthy within 180 s after start');
    },
    clean: async () => {
      const s = (await composePs()).find(p => p.Service === 'mq');
      return s && s.State === 'running' && /^healthy$/i.test(s.Health || '') ? null : `mq is ${s ? `${s.State} (${s.Health || 'no health'})` : 'absent'}`;
    },
  },
  'listener-stopped': {
    // STOP LISTENER alone only refuses NEW connections: the exporter, canary, producer and
    // consumer keep their established SVRCONN conversations and nothing is observed.
    // Force-stopping both SVRCONN channels drops those conversations; with the listener down
    // every reconnect then fails — the "process alive, unreachable by clients" fault.
    inject: () => runmqsc([
      `STOP LISTENER('${LISTENER}')`,
      ...SVRCONNS.map(c => `STOP CHANNEL('${c}') MODE(FORCE)`),
    ]),
    recover: () => runmqsc([
      `START LISTENER('${LISTENER}')`,
      ...SVRCONNS.map(c => `START CHANNEL('${c}')`),
    ]),
    clean: async () => {
      const out = await runmqsc([`DIS LSSTATUS('${LISTENER}') STATUS`, ...SVRCONNS.map(c => `DIS CHSTATUS('${c}') STATUS`)], { tolerate: ['AMQ8147', 'AMQ8420'] });
      const problems = [];
      if (!/LISTENER\(\S+\)\s+STATUS\(RUNNING\)/.test(out.replace(/\s+/g, ' '))) problems.push('listener not running');
      if (/STATUS\(STOPPED\)/.test(out)) problems.push('a SVRCONN channel is STOPPED');
      return problems.length ? problems.join(', ') : null;
    },
  },
  'queue-full': {
    // APP.BURST is defined with MAXDEPTH(200); 200 local puts fill it exactly (ratio = 1.0).
    inject: (exp) => amqsput(exp.fault.queue || 'APP.BURST', Array.from({ length: exp.fault.count || 200 }, (_, i) => `burst-${i}`)),
    recover: async (exp) => {
      const q = exp.fault?.queue || 'APP.BURST';
      await amqsget(q);
      const d = await waitFor(async () => (await depth(q)) === 0, { timeoutMs: 120000, intervalMs: 5000, label: 'burst queue drained' });
      if (d.timedOut) throw new Error(`${q} still has messages after amqsget`);
    },
    clean: async (exp) => { const q = exp?.fault?.queue || 'APP.BURST'; const n = await depth(q); return n === 0 ? null : `${q} depth ${n}`; },
  },
  'consumer-stall': {
    inject: () => stop('consumer'),
    recover: () => start('consumer'),
    clean: async () => {
      const s = (await composePs()).find(p => p.Service === 'consumer');
      return s && s.State === 'running' ? null : `consumer is ${s ? s.State : 'absent'}`;
    },
  },
  'dlq-poison': {
    inject: (exp) => amqsput('APP.DLQ', Array.from({ length: exp.fault.count || 3 }, (_, i) => `poison-${Date.now()}-${i}`)),
    recover: () => amqsget('APP.DLQ'),
    clean: async () => { const n = await depth('APP.DLQ'); return n === 0 ? null : `APP.DLQ depth ${n}`; },
  },
};

/** Current depth of a queue, read from the queue manager itself (not from the exporter). */
async function depth(queue) {
  const out = await runmqsc(`DIS QSTATUS('${queue}') CURDEPTH`);
  const m = /CURDEPTH\((\d+)\)/.exec(out);
  if (!m) throw new Error(`could not read CURDEPTH of ${queue}: ${out.trim().split('\n').slice(-3).join(' | ')}`);
  return Number(m[1]);
}

async function waitHealthy(service, timeoutMs) {
  return waitFor(async () => {
    const ps = await composePs();
    const s = ps.find(p => p.Service === service);
    return !!(s && s.State === 'running' && /^healthy$/i.test(s.Health || ''));
  }, { timeoutMs, intervalMs: 5000, label: `${service} healthy` });
}

async function firingNow(alertnames) {
  if (!alertnames.length) return [];
  const q = await promQuery(`ALERTS{alertstate="firing", alertname=~"${alertnames.join('|')}"}`);
  return q.result.map(r => r.metric.alertname);
}

/**
 * Steady-state hypothesis sampling. The pack's threshold SLIs are "good while value <= threshold"
 * and its ratio SLIs "good while value >= objective", so the worst series is max() resp. min().
 * Returns { value: worst, series: [{labels, value}], holds }.
 */
async function sampleHypothesis(sli, slo) {
  if (!sli) return null;
  const expr = sliExpr(sli);
  const lowerIsBetter = sli.type === 'threshold';
  const [all, worst] = await Promise.all([promQuery(expr), promQuery(`${lowerIsBetter ? 'max' : 'min'}(${expr})`)]);
  const value = worst.ok && worst.result.length ? Number(worst.result[0].value[1]) : null;
  const bound = lowerIsBetter ? Number(sli.threshold) : Number(slo?.objective);
  const holds = value == null || !Number.isFinite(bound) ? null : (lowerIsBetter ? value <= bound : value >= bound);
  return { value, bound, holds, series: all.result.map(r => ({ labels: r.metric, value: Number(r.value[1]) })) };
}

/** Repair the lab: run every fault's recover(), report what each did. Used by --recover. */
export async function recoverAll(pack, { log = () => {} } = {}) {
  const byId = Object.fromEntries((pack.spec.validation?.chaos_experiments || []).map(e => [e.id, e]));
  const out = [];
  for (const [id, impl] of Object.entries(faults)) {
    const exp = byId[id] || { id, fault: {} };
    try {
      const before = await impl.clean(exp);
      if (before) { log(`[recover] ${id}: ${before} → recovering`); await impl.recover(exp); }
      const after = await impl.clean(exp);
      out.push({ id, before, after, ok: after == null });
      log(`[recover] ${id}: ${after == null ? 'clean' : `STILL DIRTY: ${after}`}`);
    } catch (e) { out.push({ id, error: e.message, ok: false }); log(`[recover] ${id}: error ${e.message}`); }
  }
  return out;
}

/** Pre-flight: every selected fault's clean() must be null. Returns [{id, dirt}] for dirty ones. */
export async function preflight(experiments) {
  const dirty = [];
  for (const exp of experiments) {
    const impl = faults[exp.id];
    if (!impl) continue;
    try { const d = await impl.clean(exp); if (d) dirty.push({ id: exp.id, dirt: d }); } catch (e) { dirty.push({ id: exp.id, dirt: `clean() failed: ${e.message}` }); }
  }
  return dirty;
}

export async function chaos(pack, { only = null, log = () => {} } = {}) {
  const results = [];
  const experiments = (pack.spec.validation?.chaos_experiments || []).filter(e => !only || only.includes(e.id));
  const sloById = Object.fromEntries((pack.spec.slos || []).map(s => [s.id, s]));
  const sliById = Object.fromEntries((pack.spec.slis || []).map(s => [s.id, s]));

  // Refuse to start on a lab that still carries a previous fault: MTTD would be meaningless
  // and a second injection on top of the first is not the experiment the pack describes.
  const dirty = await preflight(experiments);
  if (dirty.length) {
    const msg = dirty.map(d => `${d.id}: ${d.dirt}`).join('; ');
    log(`[chaos] pre-flight FAILED — lab is not clean (${msg}). Run: node harness/run.mjs --recover`);
    return experiments.map(exp => ({ id: exp.id, target: exp.target, fault: exp.fault, expected: exp.expected_alerts || [], alerts: [], others: [], status: 'FAIL', notes: [`pre-flight: lab not clean before the suite (${msg}); nothing injected`] }));
  }

  // In-flight experiment, recovered by the signal handler if the run is interrupted.
  let inflight = null;
  const onSignal = async (sig) => {
    if (inflight) {
      log(`[chaos] ${sig} — recovering in-flight experiment ${inflight.exp.id} before exit`);
      try { await inflight.impl.recover(inflight.exp); log(`[chaos] ${inflight.exp.id} recovered`); } catch (e) { log(`[chaos] recover failed: ${e.message} — run: node harness/run.mjs --recover`); }
    }
    process.exit(130);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, onSignal);

  try {
    for (const exp of experiments) {
      const impl = faults[exp.id];
      const expected = exp.expected_alerts || [];
      const expectedMttdMs = durationToMs(exp.expected_mttd) || 60000;
      const holdMs = durationToMs(exp.fault?.duration) || 90000;
      const sloId = String(exp.steady_state_hypothesis || '').replace(/^ref:slos\./, '');
      const slo = sloById[sloId];
      const sli = sliById[slo?.sli];
      const row = { id: exp.id, target: exp.target, fault: exp.fault, expected, expectedMttdMs, holdMs, slo: sloId, alerts: [], others: [], status: 'FAIL', notes: [], hypothesis: {} };
      results.push(row);

      if (!impl) { row.notes.push(`no fault implementation for '${exp.id}'`); row.status = 'SKIP'; continue; }

      // steady state: none of the expected alerts firing. A gate, not a note.
      log(`[${exp.id}] waiting for steady state (${expected.join(', ')} not firing)`);
      const steady = await waitFor(async () => (await firingNow(expected)).length === 0, { timeoutMs: 240000, intervalMs: 5000, label: 'steady state' });
      if (steady.timedOut) { row.notes.push('steady state not reached within 4 min before injection; experiment not run'); continue; }
      row.hypothesis.before = await sampleHypothesis(sli, slo);

      let injectedAt = null, holdStart = null, injectAttempted = false;
      try {
        injectedAt = await sinkNow();
        holdStart = Date.now();                       // host clock, only ever compared with itself
        row.injectedAt = new Date(injectedAt).toISOString();
        log(`[${exp.id}] injecting fault ${JSON.stringify(exp.fault)}`);
        inflight = { exp, impl };
        injectAttempted = true;
        await impl.inject(exp);

        // detect
        const detectTimeout = Math.max(180000, expectedMttdMs * 3 + 60000);
        for (const name of expected) {
          const r = await waitFor(async () => (await sinkEvents({ since: injectedAt, alertname: name })).find(e => e.status === 'firing'), { timeoutMs: detectTimeout, intervalMs: 2000, label: name });
          const ev = r.value;
          const mttdMs = ev ? ev.receivedAt - injectedAt : null;
          row.alerts.push({
            alertname: name, fired: !!ev, mttdMs, withinTarget: mttdMs != null && mttdMs <= expectedMttdMs,
            firedAt: ev ? new Date(ev.receivedAt).toISOString() : null, startsAt: ev?.startsAt ?? null, fingerprint: ev?.fingerprint ?? null, labels: ev?.labels ?? null,
          });
          log(`[${exp.id}] ${name}: ${ev ? `fired after ${(mttdMs / 1000).toFixed(1)}s` : 'NOT FIRED'} (target ${expectedMttdMs / 1000}s)`);
        }

        // hold the fault for its declared duration (from injection), then sample the SLI at its worst
        const remaining = holdMs - (Date.now() - holdStart);
        if (remaining > 0) await sleep(remaining);
        row.heldMs = Date.now() - holdStart;
        if (row.heldMs > holdMs + 5000) row.notes.push(`fault held ${(row.heldMs / 1000).toFixed(0)}s (declared ${holdMs / 1000}s): detection took longer than the hold`);
        row.hypothesis.during = await sampleHypothesis(sli, slo);
        row.others = [...new Set((await sinkEvents({ since: injectedAt })).filter(e => e.status === 'firing' && !expected.includes(e.alertname)).map(e => e.alertname))];
      } catch (e) {
        row.notes.push(`experiment error: ${e.message}`);
      } finally {
        if (injectAttempted) {
          const recoveredAt = await sinkNow().catch(() => Date.now());
          row.recoveredAt = new Date(recoveredAt).toISOString();
          log(`[${exp.id}] recovering`);
          try { await impl.recover(exp); row.recovered = true; } catch (e) { row.recovered = false; row.notes.push(`recover error: ${e.message} — run: node harness/run.mjs --recover`); }
          inflight = null;
          row._recoveredAt = recoveredAt;
        }
      }
      if (!injectAttempted) continue;

      // resolution: the same alert instance (fingerprint) must resolve after recovery
      const recoveredAt = row._recoveredAt; delete row._recoveredAt;
      for (const a of row.alerts) {
        if (!a.fired) continue;
        const r = await waitFor(async () => (await sinkEvents({ since: recoveredAt, alertname: a.alertname })).find(e => e.status === 'resolved' && (!a.fingerprint || !e.fingerprint || e.fingerprint === a.fingerprint)), { timeoutMs: 360000, intervalMs: 3000, label: `${a.alertname} resolved` });
        a.resolvedAfterMs = r.value ? r.value.receivedAt - recoveredAt : null;
        a.resolvedAt = r.value ? new Date(r.value.receivedAt).toISOString() : null;
        log(`[${exp.id}] ${a.alertname}: ${r.value ? `resolved ${(a.resolvedAfterMs / 1000).toFixed(1)}s after recovery` : 'NOT RESOLVED within 6m'}`);
      }
      // post-recovery steady state before the next experiment; a timeout is graded, not dropped
      const post = await waitFor(async () => (await firingNow(expected)).length === 0, { timeoutMs: 240000, intervalMs: 5000, label: 'post-recovery steady state' });
      if (post.timedOut) row.notes.push('expected alerts still firing 4 min after recovery');
      row.hypothesis.after = await sampleHypothesis(sli, slo);
      row.events = await sinkEvents({ since: injectedAt });   // the raw ledger this row was judged from

      // hypothesis grading: must hold before and after, must be violated during
      const hyp = row.hypothesis;
      const hypNotes = [];
      if (hyp.before?.holds === false) hypNotes.push(`SLI ${sli.id} already violated before injection (${fmt(hyp.before.value)} vs ${fmt(hyp.before.bound)})`);
      if (hyp.during?.holds === true) hypNotes.push(`fault did not violate SLI ${sli.id} (${fmt(hyp.during.value)} vs ${fmt(hyp.during.bound)})`);
      if (hyp.after?.holds === false) hypNotes.push(`SLI ${sli.id} not restored after recovery (${fmt(hyp.after.value)} vs ${fmt(hyp.after.bound)})`);
      row.notes.push(...hypNotes);

      const allFired = row.alerts.every(a => a.fired);
      const allInTime = row.alerts.every(a => a.withinTarget);
      const allResolved = row.alerts.every(a => !a.fired || a.resolvedAfterMs != null);
      const hadError = row.notes.some(n => n.startsWith('experiment error') || n.startsWith('recover error'));
      row.status = !allFired || !allResolved || hadError || row.recovered === false ? 'FAIL'
        : (allInTime && !post.timedOut && !hypNotes.length ? 'PASS' : 'WARN');
    }
  } finally {
    for (const sig of ['SIGINT', 'SIGTERM']) process.removeListener(sig, onSignal);
  }
  return results;
}

const fmt = (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toPrecision(3));
