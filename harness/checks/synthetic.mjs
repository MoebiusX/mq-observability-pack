// Synthetic: is the canary / orders flow healthy right now, per the pack's synthetic_checks?
import { promQuery, scalar } from '../lib/http.mjs';

const R = (id, title, status, detail, evidence) => ({ id, title, status, detail, evidence });
const durationSec = (d) => { const m = /^(\d+)(s|m|h|d)$/.exec(String(d || '')); return m ? Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]] : Infinity; };

export async function synthetic(pack) {
  const out = [];
  const ok = (v) => Number.isFinite(v);

  const attempts = scalar(await promQuery('sum(increase(mq_canary_attempts_total[5m]))'));
  const success = scalar(await promQuery('ibmmq:canary_success:ratio_5m'));
  const p99 = scalar(await promQuery('ibmmq:canary_roundtrip:p99_5m'));
  const p50 = scalar(await promQuery('histogram_quantile(0.5, sum by (le)(rate(mq_canary_roundtrip_duration_seconds_bucket[5m])))'));
  const byResult = (await promQuery('sum(increase(mq_canary_attempts_total[5m])) by (result)')).result.map(r => ({ result: r.metric.result, n: Number(r.value[1]) }));

  out.push(R('S1', 'put-get-canary: attempts in last 5m', ok(attempts) && attempts >= 6 ? 'PASS' : 'FAIL', `${attempts} attempts (need ≥ 6 = one per 10s for at least a minute)`, byResult));
  out.push(R('S2', 'put-get-canary: success ratio ≥ 0.99 (5m)', ok(success) && success >= 0.99 ? 'PASS' : 'FAIL', ok(success) ? `${(success * 100).toFixed(2)}%` : 'no data', { success }));
  out.push(R('S3', 'put-get-canary: p99 round-trip < 500 ms (5m)', ok(p99) && p99 < 0.5 ? 'PASS' : (ok(p99) ? 'FAIL' : 'WARN'), ok(p99) ? `p50 ${(p50 * 1000).toFixed(1)} ms, p99 ${(p99 * 1000).toFixed(1)} ms` : 'no histogram data yet', { p50, p99 }));

  const produced = scalar(await promQuery('sum(rate(mq_orders_produced_total[2m]))'));
  const consumed = scalar(await promQuery('sum(rate(mq_orders_consumed_total[2m]))'));
  const putErr = scalar(await promQuery('sum(increase(mq_orders_put_errors_total[5m]))')) || 0;
  const depth = scalar(await promQuery('max(ibmmq_queue_depth{queue="APP.ORDERS.REQ"})'));
  const age = scalar(await promQuery('max(ibmmq_queue_oldest_message_age{queue="APP.ORDERS.REQ"})'));
  out.push(R('S4', 'orders-flow: producer and consumer both moving', ok(produced) && ok(consumed) && produced > 0 && consumed > 0 ? 'PASS' : 'FAIL',
    `produced ${produced?.toFixed(2)}/s, consumed ${consumed?.toFixed(2)}/s, put errors(5m)=${putErr}, depth=${depth}, oldest=${age}s`, { produced, consumed, putErr, depth, age }));

  // S5 judges symptom alerts only. Multi-window burn-rate alerts (spec.policy) are graded in
  // S6: a slow window (1h/6h) legitimately keeps burning for hours after an incident such as
  // a chaos run, which is not a steady-state defect; a fast window firing at steady state is.
  const all = (await promQuery('ALERTS{alertstate="firing", pack="ibmmq"}')).result.map(r => r.metric);
  const symptom = [...new Set(all.filter(m => !m.burn_rate && m.kind !== 'forecast').map(m => m.alertname))];
  out.push(R('S5', 'steady state: no symptom alert firing', symptom.length ? 'FAIL' : 'PASS', symptom.length ? `firing: ${symptom.join(', ')}` : 'none firing', symptom));

  const burn = all.filter(m => m.burn_rate);
  const fast = [...new Set(burn.filter(m => durationSec(m.window_long) <= 3600).map(m => m.alertname))];
  const slow = [...new Set(burn.filter(m => durationSec(m.window_long) > 3600).map(m => m.alertname))];
  const forecast = [...new Set(all.filter(m => m.kind === 'forecast').map(m => m.alertname))];
  out.push(R('S6', 'SLO burn: no fast-window burn-rate alert firing (slow 6h windows may still be paying for incidents of the last hours)',
    fast.length ? 'FAIL' : (slow.length || forecast.length ? 'WARN' : 'PASS'),
    [fast.length ? `fast: ${fast.join(', ')}` : null, slow.length ? `slow (informational): ${slow.join(', ')}` : null, forecast.length ? `forecast: ${forecast.join(', ')}` : null].filter(Boolean).join('; ') || 'no burn-rate or forecast alert firing',
    { fast, slow, forecast }));

  return out;
}
