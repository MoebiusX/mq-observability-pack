// Chaos: execute every pack chaos_experiment with a docker-level fault, measure MTTD
// (alert-sink receivedAt − injection timestamp) against expected_mttd, then recover
// and confirm the alerts resolve. Real faults, real alerts, real timestamps.
import { stop, start, runmqsc, amqsput, amqsget, composePs } from '../lib/docker.mjs';
import { promQuery, scalar, sinkEvents, waitFor, sleep } from '../lib/http.mjs';
import { durationToMs, sliExpr } from '../lib/pack.mjs';

/** Fault implementations, keyed by pack chaos_experiment id. */
const faults = {
  'qmgr-down': {
    inject: () => stop('mq'),
    recover: async () => { await start('mq'); await waitHealthy('mq', 180000); },
  },
  'listener-stopped': {
    inject: () => runmqsc(`STOP LISTENER('SYSTEM.LISTENER.TCP.1')`),
    recover: () => runmqsc(`START LISTENER('SYSTEM.LISTENER.TCP.1')`),
  },
  'queue-full': {
    // APP.BURST is defined with MAXDEPTH(200); 200 local puts fill it exactly (ratio = 1.0).
    inject: (exp) => amqsput(exp.fault.queue || 'APP.BURST', Array.from({ length: exp.fault.count || 200 }, (_, i) => `burst-${i}`)),
    recover: async (exp) => {
      await amqsget(exp.fault.queue || 'APP.BURST');
      await waitFor(async () => scalar(await promQuery(`max(ibmmq_queue_depth{queue="${exp.fault.queue || 'APP.BURST'}"})`)) === 0, { timeoutMs: 120000, intervalMs: 5000, label: 'burst queue drained' });
    },
  },
  'consumer-stall': {
    inject: () => stop('consumer'),
    recover: () => start('consumer'),
  },
  'dlq-poison': {
    inject: (exp) => amqsput('APP.DLQ', Array.from({ length: exp.fault.count || 3 }, (_, i) => `poison-${Date.now()}-${i}`)),
    recover: () => amqsget('APP.DLQ'),
  },
};

async function waitHealthy(service, timeoutMs) {
  return waitFor(async () => {
    const ps = await composePs();
    const s = ps.find(p => p.Service === service);
    return s && /healthy/i.test(s.Health || s.Status || '');
  }, { timeoutMs, intervalMs: 5000, label: `${service} healthy` });
}

async function firingNow(alertnames) {
  const q = await promQuery(`ALERTS{alertstate="firing", alertname=~"${alertnames.join('|')}"}`);
  return q.result.map(r => r.metric.alertname);
}

export async function chaos(pack, { only = null, log = () => {} } = {}) {
  const results = [];
  const experiments = (pack.spec.validation?.chaos_experiments || []).filter(e => !only || only.includes(e.id));
  const sloById = Object.fromEntries((pack.spec.slos || []).map(s => [s.id, s]));
  const sliById = Object.fromEntries((pack.spec.slis || []).map(s => [s.id, s]));

  for (const exp of experiments) {
    const impl = faults[exp.id];
    const expected = exp.expected_alerts || [];
    const expectedMttdMs = durationToMs(exp.expected_mttd) || 60000;
    const holdMs = durationToMs(exp.fault?.duration) || 90000;
    const sloId = String(exp.steady_state_hypothesis || '').replace(/^ref:slos\./, '');
    const sli = sliById[sloById[sloId]?.sli];
    const row = { id: exp.id, target: exp.target, fault: exp.fault, expected, expectedMttdMs, holdMs, slo: sloId, alerts: [], others: [], status: 'FAIL', notes: [] };
    results.push(row);

    if (!impl) { row.notes.push(`no fault implementation for '${exp.id}'`); row.status = 'SKIP'; continue; }

    // steady state: none of the expected alerts firing
    log(`[${exp.id}] waiting for steady state (${expected.join(', ')} not firing)`);
    const steady = await waitFor(async () => (await firingNow(expected)).length === 0, { timeoutMs: 240000, intervalMs: 5000, label: 'steady state' });
    if (steady.timedOut) { row.notes.push('steady state not reached before injection; MTTD figures are unreliable'); }
    row.sliBefore = sli ? scalar(await promQuery(sliExpr(sli))) : null;

    // inject
    const injectedAt = Date.now();
    row.injectedAt = new Date(injectedAt).toISOString();
    log(`[${exp.id}] injecting fault ${JSON.stringify(exp.fault)}`);
    try { await impl.inject(exp); } catch (e) { row.notes.push(`inject error: ${e.message}`); }

    // detect
    const detectTimeout = Math.max(180000, expectedMttdMs * 3 + 60000);
    for (const name of expected) {
      const r = await waitFor(async () => (await sinkEvents({ since: injectedAt, alertname: name })).find(e => e.status === 'firing'), { timeoutMs: detectTimeout, intervalMs: 2000, label: name });
      const mttdMs = r.value ? r.value.receivedAt - injectedAt : null;
      row.alerts.push({ alertname: name, fired: !!r.value, mttdMs, withinTarget: mttdMs != null && mttdMs <= expectedMttdMs, labels: r.value?.labels ?? null });
      log(`[${exp.id}] ${name}: ${r.value ? `fired after ${(mttdMs / 1000).toFixed(1)}s` : 'NOT FIRED'} (target ${expectedMttdMs / 1000}s)`);
    }

    // hold the fault for its declared duration, sample the SLI at its worst
    const remaining = holdMs - (Date.now() - injectedAt);
    if (remaining > 0) await sleep(remaining);
    row.sliDuring = sli ? scalar(await promQuery(sliExpr(sli))) : null;
    row.others = [...new Set((await sinkEvents({ since: injectedAt })).filter(e => e.status === 'firing' && !expected.includes(e.alertname)).map(e => e.alertname))];

    // recover
    const recoveredAt = Date.now();
    row.recoveredAt = new Date(recoveredAt).toISOString();
    log(`[${exp.id}] recovering`);
    try { await impl.recover(exp); } catch (e) { row.notes.push(`recover error: ${e.message}`); }
    for (const a of row.alerts) {
      if (!a.fired) continue;
      const r = await waitFor(async () => (await sinkEvents({ since: recoveredAt, alertname: a.alertname })).find(e => e.status === 'resolved'), { timeoutMs: 360000, intervalMs: 3000, label: `${a.alertname} resolved` });
      a.resolvedAfterMs = r.value ? r.value.receivedAt - recoveredAt : null;
      log(`[${exp.id}] ${a.alertname}: ${r.value ? `resolved ${(a.resolvedAfterMs / 1000).toFixed(1)}s after recovery` : 'NOT RESOLVED within 6m'}`);
    }
    // give the system a moment before the next experiment
    await waitFor(async () => (await firingNow(expected)).length === 0, { timeoutMs: 240000, intervalMs: 5000, label: 'post-recovery steady state' });
    row.sliAfter = sli ? scalar(await promQuery(sliExpr(sli))) : null;

    const allFired = row.alerts.every(a => a.fired);
    const allInTime = row.alerts.every(a => a.withinTarget);
    const allResolved = row.alerts.every(a => !a.fired || a.resolvedAfterMs != null);
    row.status = !allFired || !allResolved ? 'FAIL' : (allInTime ? 'PASS' : 'WARN');
  }
  return results;
}
