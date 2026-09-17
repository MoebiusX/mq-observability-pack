// The IBM MQ pack's four boards, built with Observogram's dashboard library
// (vendor/observogram/lib/dashboards/lib.mjs: visual system, panel factories, flow layout and the
// pack-derived blocks). This module holds only what is MQ-specific: the hand-written SLI tiles,
// the SLO labels, the synthetic canary/orders panels and the "Signals" rows (availability,
// queues, channels, resources). tools/gen-dashboards.mjs calls boards() and writes the files
// the pack's `dashboards[].source` entries name.
//
// The unified board follows the pack's own structure (the Kafka reference pack's order):
// §1-2 SLIs and SLOs → §10 baselines & validation (MTTD, MTTR, certification, synthetic) →
// §7-8 policy and alerting → §9 remediation → the signals behind the SLIs → §3-5 pipelines,
// storage and queries → logs and traces. What matters is at the top: SLOs, MTTD, MTTR.
// Layout is computed by flow(): add panels in reading order, never by coordinates.
//
// `site` (gen-site's dashboardOptions or a site.json manifest; absent = the lab) drives what
// differs between environments without touching the lab output (the four lab boards are
// byte-identical to stack/grafana/dashboards, tools/test-site.mjs T10):
//   vantage    dual: the native job exists (process tiles, native series); single: nothing reads
//              job="ibmmq-native" and the queue manager's $SYS series come from the exporter job
//   profile    container: the queue manager's own endpoint exposes true counters (`_total`,
//              rate()); non-container: the MQ SERVICE mq_prometheus exposes per-interval deltas
//              (`_count`, sum_over_time(...[2m]) / 120) under the names of the onboarding guide's
//              appendix B (docs/INSTRUMENTING-EXISTING-MQ.md)
//   names      app queue pattern, DEADQ, canary and orders queues (orders null: no orders panels)
//   the process SLI/SLO panels follow the pack: a site pack without qmgr_process_up has none

const SLO_LABEL = {
  qmgr_process_up_99_9: 'Process up · 99.9 %', qmgr_reachability_99_9: 'Reachable · 99.9 %', queue_headroom_99_9: 'Queue headroom · 99.9 %',
  message_age_99_under_60s: 'Message age < 60 s · 99 %', dlq_empty_99_9: 'DLQ empty · 99.9 %', canary_success_99_9: 'Canary success · 99.9 %',
  canary_latency_99_p99_500ms: 'Canary p99 < 500 ms · 99 %', log_latency_99_under_20ms: 'Log latency < 20 ms · 99 %',
};
const BOARDS = [['ibmmq-unified', 'Unified'], ['ibmmq-overview', 'Overview'], ['ibmmq-queues', 'Queues & channels'], ['ibmmq-slo-burn', 'SLO burn']];
const LAB = { environment: 'lab', vantage: 'dual', profile: 'container', names: { app_queue_pattern: 'APP.*', deadq: 'APP.DLQ', canary_queue: 'APP.CANARY', orders_queue: 'APP.ORDERS.REQ' }, monitoring_channels: ['DEV.ADMIN.SVRCONN'] };
// Native-endpoint counter → the exporter's per-interval delta of the same thing (appendix B).
const DELTA = {
  commit_total: 'commit_count', rollback_total: 'rollback_count', mqconn_mqconnx_total: 'mqconn_mqconnx_count',
  mqput_mqput1_total: 'interval_mqput_mqput1_total_count', destructive_get_total: 'interval_destructive_get_total_count',
  expired_message_total: 'expired_message_count', failed_mqconn_mqconnx_total: 'failed_mqconn_mqconnx_count',
  failed_mqget_total: 'failed_mqget_count', failed_mqopen_total: 'failed_mqopen_count', failed_mqput_total: 'failed_mqput_count',
  persistent_message_mqput_total: 'persistent_message_mqput_count', persistent_message_mqput1_total: 'persistent_message_mqput1_count',
  non_persistent_message_mqput_total: 'non_persistent_message_mqput_count', non_persistent_message_mqput1_total: 'non_persistent_message_mqput1_count',
  log_logical_written_bytes_total: 'log_logical_written_bytes', log_physical_written_bytes_total: 'log_physical_written_bytes',
};
const humanize = (id) => String(id).replace(/_/g, ' ');

/** Normalise `site`: gen-site's dashboardOptions ({ names, monitoring_channels }) or a site.json manifest ({ params, queue_managers }). */
function siteOptions(site) {
  if (!site) return LAB;
  const names = { ...LAB.names, ...(site.names || site.params || {}) };
  const fromManifest = Array.isArray(site.queue_managers) ? [...new Set(site.queue_managers.map(q => q?.params?.channels?.monitoring).filter(Boolean))] : [];
  const monitoring_channels = site.monitoring_channels?.length ? site.monitoring_channels : fromManifest.length ? fromManifest : LAB.monitoring_channels;
  return { environment: site.environment || LAB.environment, vantage: site.vantage || LAB.vantage, profile: site.profile || LAB.profile, names, monitoring_channels };
}

export function boards({ pack, lib, repoUrl, site = null }) {
  const S = siteOptions(site);
  const sloLabel = Object.fromEntries(pack.spec.slos.map(s => [s.id, SLO_LABEL[s.id] || humanize(s.id)]));
  lib.configure({ pack, repoUrl, displayName: 'IBM MQ', sloLabel, certSel: 'job="certification"', boards: BOARDS });
  const { C, okAbove, okBelow, byName, stat, gauge, bargauge, ts, timeline, table, traces, logs, row, header, dashboard, resetIds, DS, LOKI,
    STATE_UPDOWN, burnThresholds, burnBars, burnCurves, alertTimelines, alertTable, certTiles, mttdBars, mttrBars, certCounts, remediationTable } = lib;
  const SLO_RENAME = lib.ctx().sloRename;

  // ---------------------------------------------------------------- site-dependent forms
  const hasProcess = pack.spec.slis.some(s => s.id === 'qmgr_process_up');   // the site pack keeps or drops the process SLI (gen-site packRemovals)
  const hasNative = S.vantage === 'dual';                                      // job="ibmmq-native" is scraped
  const orders = S.names.orders_queue || null;
  const chan = S.monitoring_channels.join(' / ');
  const suffix = S.environment === 'lab' ? '' : ` · ${S.environment}`;
  const where = S.environment === 'lab' ? 'the IBM MQ lab' : `the IBM MQ ${S.environment} site`;
  const EXP = 'job="ibmmq-exporter"', NAT = 'job="ibmmq-native"', Q = 'queue=~"$queue"';
  const NATJOB = hasNative ? NAT : EXP;                                       // the job that carries the queue manager's own series
  const deltas = !(S.profile === 'container' && hasNative);                   // only the container's built-in endpoint has _total counters
  /** Per-second rate of a queue-manager counter: rate() of the native `_total`, or the exporter delta estimator. */
  const qmgrCounter = (name) => {
    if (!deltas) return `rate(ibmmq_qmgr_${name}{${NATJOB}}[2m])`;
    if (!DELTA[name]) throw new Error(`no exporter equivalent for ibmmq_qmgr_${name} (appendix B)`);
    return `sum_over_time(ibmmq_qmgr_${DELTA[name]}{${NATJOB}}[2m]) / 120`;
  };
  /** A queue-manager gauge from the job that has it; two exporter names differ from the native endpoint's. */
  const qmgrGauge = (name) => {
    if (deltas && name === 'log_primary_space_in_use_percentage') return `ibmmq_qmgr_log_current_primary_space_in_use_percentage{${NATJOB}}`;
    if (deltas && name === 'log_file_system_free_space_percentage') return `100 * ibmmq_qmgr_log_file_system_free_space_bytes{${NATJOB}} / ibmmq_qmgr_log_file_system_max_bytes{${NATJOB}}`;
    return `ibmmq_qmgr_${name}{${NATJOB}}`;
  };
  const mqiDesc = deltas ? 'Queue-manager-level MQI rates from the exporter\'s per-interval counts (sum over 2 m ÷ 120 s).' : 'Queue-manager-level MQI rates from the native endpoint (true counters, rate() is right here).';

  // ---------------------------------------------------------------- MQ-specific building blocks
  const STATE_QMGR = [{ type: 'value', options: { '2': { text: 'RUNNING', color: C.green }, '0': { text: 'UNREACHABLE', color: C.red }, '1': { text: 'STARTING', color: C.amber }, '3': { text: 'QUIESCING', color: C.amber } } }];
  const STATE_SERVICE = [{ type: 'value', options: { '2': { text: 'RUNNING', color: C.green }, '1': { text: 'STARTING', color: C.amber }, '0': { text: 'STOPPED', color: C.red } } }];
  const STATE_CHANNEL = [{ type: 'value', options: { '2': { text: 'RUNNING', color: C.green }, '1': { text: 'TRANSITION', color: C.amber }, '0': { text: 'INACTIVE / STOPPED', color: C.slate } } }];
  const RESULT_COLORS = { ok: C.green, get_timeout: C.amber, connect_failed: C.red, payload_mismatch: C.pink, put_failed_q_full: C.violet, auth_failed: C.red, handle_invalid: C.amber, message_too_large: C.violet, error: C.red };

  const sliTiles = () => [
    ...(hasProcess ? [stat('Process up', 'ibmmq:qmgr_process_up:ratio_5m', { binds: 'slis.qmgr_process_up', desc: '5-minute fraction of scrapes in which the queue manager\'s native metrics endpoint answered. SLO 99.9 % over 30 d.', unit: 'percentunit', decimals: 2, thresholds: okBelow(0.999, 0.99), w: 3 })] : []),
    stat('Reachable', 'ibmmq:qmgr_reachability:ratio_5m', { binds: 'slis.qmgr_reachability', desc: `5-minute fraction of samples in which an MQ client (the exporter over ${chan}) saw the queue manager RUNNING. Diverges from "process up" on listener, channel, CHLAUTH or CONNAUTH faults.`, unit: 'percentunit', decimals: 2, thresholds: okBelow(0.999, 0.99), w: 3 }),
    stat('Queue headroom', 'max(ibmmq:queue_depth_headroom:ratio)', { binds: 'slis.queue_depth_headroom', desc: 'Highest depth / MAXDEPTH across application queues. 100 % means producers get MQRC_Q_FULL (2053).', unit: 'percentunit', decimals: 1, thresholds: okAbove(0.8, 1), w: 3 }),
    stat('Oldest message', 'max(ibmmq:oldest_message_age:seconds_max)', { binds: 'slis.oldest_message_age', desc: 'Age of the oldest message on any application queue (DLQ excluded). Consumer health.', unit: 's', decimals: 0, thresholds: okAbove(60, 120), w: 3 }),
    stat('DLQ depth', 'ibmmq:dlq_depth:max', { binds: 'slis.dlq_depth', desc: `Messages on the queue manager\'s dead-letter queue (${S.names.deadq}).`, decimals: 0, thresholds: okAbove(1, 10), w: 3 }),
    stat('Canary success', 'ibmmq:canary_success:ratio_5m', { binds: 'slis.canary_success', desc: `5-minute success ratio of the synthetic put→get probe on ${S.names.canary_queue} (matching payload within 5 s).`, unit: 'percentunit', decimals: 2, thresholds: okBelow(0.999, 0.99), w: 3 }),
    stat('Canary p99', 'ibmmq:canary_roundtrip:p99_5m', { binds: 'slis.canary_roundtrip_p99', desc: 'p99 put→get round-trip of successful probes over 5 minutes (connect time excluded).', unit: 's', decimals: 1, thresholds: okAbove(0.5, 1), w: 3 }),
    stat('Log write latency', 'ibmmq:log_write_latency:seconds', { binds: 'slis.log_write_latency', desc: 'Recovery-log write latency reported by the queue manager. Persistent-message throughput depends on it.', unit: 's', decimals: 1, thresholds: okAbove(0.02, 0.05), w: 3 }),
  ];
  const ordersFlow = (opts) => ts('Orders flow · produced vs consumed', [
    { expr: 'sum(rate(mq_orders_produced_total[2m]))', legend: 'produced/s' },
    { expr: 'sum(rate(mq_orders_consumed_total[2m]))', legend: 'consumed/s' },
    { expr: 'sum(rate(mq_orders_put_errors_total[2m]))', legend: 'put errors/s' },
  ], { unit: 'ops', colors: { 'produced/s': C.blue, 'consumed/s': C.green, 'put errors/s': C.red }, ...opts });
  const synthetic = () => [
    stat('Canary attempts · 1 h', 'sum(increase(mq_canary_attempts_total[1h]))', { decimals: 0, mode: 'none', spark: false, w: 4 }),
    stat('Canary failures · 1 h', 'sum(increase(mq_canary_attempts_total{result!="ok"}[1h])) or vector(0)', { decimals: 0, spark: false, thresholds: okAbove(1, 5), w: 4 }),
    stat('Canary p50', 'histogram_quantile(0.5, sum by (le)(rate(mq_canary_roundtrip_duration_seconds_bucket{result="ok"}[5m])))', { unit: 's', decimals: 1, mode: 'none', w: 4 }),
    ...(orders ? [
      stat('Orders produced · 1 h', 'sum(increase(mq_orders_produced_total[1h]))', { decimals: 0, mode: 'none', spark: false, w: 4 }),
      stat('Orders consumed · 1 h', 'sum(increase(mq_orders_consumed_total[1h]))', { decimals: 0, mode: 'none', spark: false, w: 4 }),
      stat('Order put errors · 1 h', 'sum(increase(mq_orders_put_errors_total[1h])) or vector(0)', { decimals: 0, spark: false, thresholds: okAbove(1, 10), w: 4 }),
    ] : []),
    ts('Canary attempts by result', [{ expr: 'sum by (result)(rate(mq_canary_attempts_total[2m]))', legend: '{{result}}' }], { unit: 'ops', h: 6, colors: RESULT_COLORS, stack: true }),
    ts('Canary round-trip · p50 / p99', [
      { expr: 'histogram_quantile(0.5, sum by (le)(rate(mq_canary_roundtrip_duration_seconds_bucket{result="ok"}[5m])))', legend: 'p50' },
      { expr: 'ibmmq:canary_roundtrip:p99_5m', legend: 'p99' },
    ], { unit: 's', h: 6, colors: { p50: C.blue, p99: C.amber }, lines: [{ value: 0.5, color: C.red }] }),
    ...(orders ? [
      ordersFlow({ h: 6 }),
      ts(`${orders} · depth and oldest age`, [
        { expr: `max(ibmmq_queue_depth{${EXP}, queue="${orders}"})`, legend: 'depth' },
        { expr: `max(ibmmq_queue_oldest_message_age{${EXP}, queue="${orders}"})`, legend: 'oldest age' },
      ], { h: 6, decimals: 0, colors: { depth: C.blue, 'oldest age': C.amber }, axisRight: [{ name: 'oldest age', unit: 's', min: 0 }] }),
    ] : []),
  ];

  // ---------------------------------------------------------------- overview
  resetIds();
  const overview = dashboard('ibmmq-overview', `IBM MQ — Overview (pack SLIs)${suffix}`, [
    header('Overview', 'The eight pack SLIs at a glance, the last certification\'s MTTD and MTTR, and the signals behind them.', 'ibmmq-overview'),
    ...sliTiles(),
    ...certTiles().slice(0, 5),
    stat('Symptom alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", burn_rate="", kind=""}) or vector(0)', { desc: 'Symptom alerts currently firing (burn-rate and forecast alerts excluded).', decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 4 }),
    hasProcess
      ? stat('Burn 1 h · process up', 'ibmmq:errorbudget:burn_1h{slo="qmgr_process_up_99_9"}', { binds: 'slos.qmgr_process_up_99_9', desc: sloLabel.qmgr_process_up_99_9, decimals: 1, thresholds: burnThresholds('qmgr_process_up_99_9'), w: 4 })
      : stat('Burn 1 h · reachable', 'ibmmq:errorbudget:burn_1h{slo="qmgr_reachability_99_9"}', { binds: 'slos.qmgr_reachability_99_9', desc: sloLabel.qmgr_reachability_99_9, decimals: 1, thresholds: burnThresholds('qmgr_reachability_99_9'), w: 4 }),
    stat('Burn 1 h · canary success', 'ibmmq:errorbudget:burn_1h{slo="canary_success_99_9"}', { binds: 'slos.canary_success_99_9', desc: sloLabel.canary_success_99_9, decimals: 1, thresholds: burnThresholds('canary_success_99_9'), w: 4 }),
    stat('Connections', 'max(ibmmq_qmgr_connection_count{job="ibmmq-exporter"})', { desc: 'Open connections to the queue manager (client view).', decimals: 0, mode: 'none', w: 4 }),
    alertTimelines(12, 4)[0],
    hasProcess
      ? ts('Availability · process vs reachability', [
        { expr: 'ibmmq:qmgr_process_up:ratio_5m', legend: 'process up (native :9157)' },
        { expr: 'ibmmq:qmgr_reachability:ratio_5m', legend: 'reachable (client exporter)' },
      ], { binds: 'slis.qmgr_process_up', unit: 'percentunit', min: 0, max: 1, colors: { 'process up (native :9157)': C.green, 'reachable (client exporter)': C.blue }, lines: [{ value: 0.999 }] })
      : ts('Availability · reachability', [
        { expr: 'ibmmq:qmgr_reachability:ratio_5m', legend: 'reachable (client exporter)' },
      ], { binds: 'slis.qmgr_reachability', unit: 'percentunit', min: 0, max: 1, colors: { 'reachable (client exporter)': C.blue }, lines: [{ value: 0.999 }] }),
    ts('Canary round-trip · p50 / p99', [
      { expr: 'histogram_quantile(0.5, sum by (le)(rate(mq_canary_roundtrip_duration_seconds_bucket{result="ok"}[5m])))', legend: 'p50' },
      { expr: 'ibmmq:canary_roundtrip:p99_5m', legend: 'p99' },
    ], { binds: 'slis.canary_roundtrip_p99', unit: 's', colors: { p50: C.blue, p99: C.amber }, lines: [{ value: 0.5, color: C.red }] }),
    ts('Queue depth headroom by queue', [{ expr: 'ibmmq:queue_depth_headroom:ratio', legend: '{{queue}}' }], { binds: 'slis.queue_depth_headroom', unit: 'percentunit', min: 0, max: 1, many: true, lines: [{ value: 0.8 }, { value: 1, color: C.red }] }),
    ts('Oldest message age by queue', [{ expr: 'ibmmq:oldest_message_age:seconds_max', legend: '{{queue}}' }], { binds: 'slis.oldest_message_age', unit: 's', many: true, lines: [{ value: 60 }] }),
    ts('Canary attempts by result', [{ expr: 'sum by (result)(rate(mq_canary_attempts_total[2m]))', legend: '{{result}}' }], { binds: 'slis.canary_success', unit: 'ops', colors: RESULT_COLORS, stack: true }),
    ...(orders ? [ordersFlow({})] : []),
    ts('Recovery log write latency', [{ expr: 'ibmmq:log_write_latency:seconds', legend: '{{qmgr}}' }], { binds: 'slis.log_write_latency', unit: 's', colors: { '/.*/': C.violet }, lines: [{ value: 0.02 }] }),
    ts('Queue manager · CPU and filesystem', [
      { expr: 'max by (qmgr)(ibmmq_qmgr_user_cpu_time_percentage{job="ibmmq-exporter"})', legend: 'user cpu' },
      { expr: 'max by (qmgr)(ibmmq_qmgr_system_cpu_time_percentage{job="ibmmq-exporter"})', legend: 'system cpu' },
      { expr: 'min by (qmgr)(ibmmq_qmgr_queue_manager_file_system_free_space_percentage{job="ibmmq-exporter"})', legend: 'filesystem free' },
    ], { unit: 'percent', min: 0, max: 100, colors: { 'user cpu': C.blue, 'system cpu': C.violet, 'filesystem free': C.green } }),
    // The stored line is already the human-readable MQ message (the collector parsed the JSON
    // and kept the id as structured metadata), so no `| json` here: it errored on 96 % of lines.
    logs('Queue manager log', '{service_name="ibmmq"} | line_format "{{.mq_message_id}} {{__line__}}"', { desc: 'MQ console log (AMQ message id + text), parsed by the collector.', h: 8 }),
  ], ['ibmmq', 'pack', 'slo'], { description: 'IBM MQ pack SLIs, the last certification\'s MTTD/MTTR, error-budget burn and the signals behind them.' });

  // ---------------------------------------------------------------- queues & channels
  resetIds();
  const queues = dashboard('ibmmq-queues', `IBM MQ — Queues & Channels${suffix}`, [
    header('Queues & channels', 'Per-queue depth, headroom, age, throughput and handles; channel state and traffic.', 'ibmmq-queues'),
    bargauge('Headroom by queue · depth / MAXDEPTH', 'ibmmq:queue_depth_headroom:ratio', { legend: '{{queue}}', unit: 'percentunit', max: 1, decimals: 1, thresholds: okAbove(0.8, 1), desc: 'Current depth as a fraction of MAXDEPTH per application queue.', w: 8, h: 8 }),
    ts('Depth by queue', [{ expr: 'ibmmq_queue_depth{job="ibmmq-exporter"}', legend: '{{queue}}' }], { binds: 'ref:queries.per_queue_depth', desc: 'Current depth per queue (exporter, 10 s publications).', w: 8, h: 8, many: true }),
    ts('Oldest message age by queue', [{ expr: 'ibmmq_queue_oldest_message_age{job="ibmmq-exporter"}', legend: '{{queue}}' }], { unit: 's', w: 8, h: 8, lines: [{ value: 60 }] }),
    // mq_prometheus publishes MQI counts as PER-INTERVAL DELTAS (one value per 10 s $SYS
    // publication), scraped as gauges (overrideCType: false). Per-second rate =
    // sum_over_time(...[2m]) / 120 — never rate() (docs/catalogue-evidence/ibmmq.md §4).
    ts('Put rate by queue', [{ expr: 'sum by (queue)(sum_over_time(ibmmq_queue_mqput_mqput1_count{job="ibmmq-exporter"}[2m])) / 120', legend: '{{queue}}' }], { binds: 'ref:queries.per_queue_throughput', desc: 'MQPUT + MQPUT1 per second, from the exporter\'s per-interval counts (sum over 2 m ÷ 120 s).', unit: 'ops', many: true }),
    ts('Get rate by queue', [{ expr: 'sum by (queue)(sum_over_time(ibmmq_queue_mqget_count{job="ibmmq-exporter"}[2m])) / 120', legend: '{{queue}}' }], { desc: 'MQGET per second, same estimator.', unit: 'ops', many: true }),
    ts('Queue time · short / long sample', [
      { expr: 'ibmmq_queue_qtime_short{job="ibmmq-exporter"}', legend: '{{queue}} short' },
      { expr: 'ibmmq_queue_qtime_long{job="ibmmq-exporter"}', legend: '{{queue}} long' },
    ], { desc: 'Time messages spend on the queue (MQ QTIME short and long moving averages).', unit: 'µs', many: true }),
    ts('Open handles · input / output', [
      { expr: 'ibmmq_queue_input_handles{job="ibmmq-exporter"}', legend: '{{queue}} in' },
      { expr: 'ibmmq_queue_output_handles{job="ibmmq-exporter"}', legend: '{{queue}} out' },
    ], { desc: 'Applications with the queue open for input (getters) and output (putters).', many: true, step: true }),
    timeline('Channel status', [{ expr: 'max by (channel, type)(ibmmq_channel_status_squash{job="ibmmq-exporter"})', legend: '{{channel}} ({{type}})' }], { binds: 'ref:queries.per_channel_status', desc: 'Squashed channel status: RUNNING, TRANSITION (binding, starting, retrying, stopping) or INACTIVE / STOPPED.', mappings: STATE_CHANNEL, h: 6 }),
    ts('Channel instances', [{ expr: 'max by (channel)(ibmmq_channel_cur_inst{job="ibmmq-exporter"})', legend: '{{channel}}' }], { desc: 'Current instances per channel (one per client conversation for SVRCONN).', step: true, h: 6, decimals: 0 }),
    ts('Channel messages / s', [{ expr: 'sum by (channel)(sum_over_time(ibmmq_channel_messages{job="ibmmq-exporter"}[2m])) / 120', legend: '{{channel}}' }], { desc: 'Per-interval channel counts (DIS CHSTATUS MSGS deltas), sum over 2 m ÷ 120 s.', unit: 'ops', h: 6 }),
    // Native endpoint names verified live against MQ 10.0.0.5: counters carry a _total suffix
    // and gets are reported as destructive_get (docs/catalogue-evidence/ibmmq.md §4b).
    ts('Queue manager MQI · commits, puts, gets', [
      { expr: qmgrCounter('commit_total'), legend: 'commits/s' },
      { expr: qmgrCounter('mqput_mqput1_total'), legend: 'mqput/s' },
      { expr: qmgrCounter('destructive_get_total'), legend: 'destructive get/s' },
    ], { desc: mqiDesc, unit: 'ops', h: 6, colors: { 'commits/s': C.violet, 'mqput/s': C.blue, 'destructive get/s': C.green } }),
  ], ['ibmmq', 'pack'], { description: 'IBM MQ queues and channels in detail.' });

  // ---------------------------------------------------------------- slo burn
  resetIds();
  const sloBurn = dashboard('ibmmq-slo-burn', `IBM MQ — SLO burn rates${suffix}`, [
    header('SLO burn rates', 'Error-budget burn per SLO on the fast and slow windows, and the burn-rate / forecast alert history.', 'ibmmq-slo-burn'),
    ...pack.spec.slos.map(s => stat(`${SLO_RENAME[s.id]} · burn 1 h`, `ibmmq:errorbudget:burn_1h{slo="${s.id}"}`, { binds: `slos.${s.id}`, desc: `1 h burn rate of ${sloLabel[s.id]} (objective ${s.objective} over ${s.window}).`, decimals: 1, thresholds: burnThresholds(s.id), w: 3 })),
    burnBars(null),
    alertTimelines(12, 8)[1],
    ...burnCurves(12),
    ts('Error ratio · 5 m, per SLI', [{ expr: '{__name__=~"ibmmq:.*:error_ratio_5m"}', legend: '{{__name__}}' }], { desc: 'Bad samples over expected samples in the last 5 minutes, per SLI.', unit: 'percentunit', many: true, rename: Object.fromEntries(pack.spec.slis.map(s => [`ibmmq:${s.id}:error_ratio_5m`, s.id])) }),
    stat('Burn-rate alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", burn_rate!=""}) or vector(0)', { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 6, h: 7 }),
    stat('Forecast alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", kind="forecast"}) or vector(0)', { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 6, h: 7 }),
  ], ['ibmmq', 'pack', 'slo'], { description: 'Multi-window burn rates and forecasts for every IBM MQ pack SLO.' });

  // ---------------------------------------------------------------- unified (pack order)
  resetIds();
  const LOGSVC = 'service_name=~"${service:regex}"';
  const unified = dashboard('ibmmq-unified', `IBM MQ — Unified Observability${suffix}`, [
    header('Unified Observability', 'One board in the pack\'s own order: SLIs and SLOs, the validation that proves them (MTTD, MTTR, certification), policy and alerting, remediation, the signals underneath, the pipeline, logs and traces.', 'ibmmq-unified'),

    row('§1-2 · Contract — SLIs and SLOs'),
    ...sliTiles(),
    burnBars(pack.spec.slos.map(s => `slos.${s.id}`), 12, 8),
    ...burnCurves(6, 'hidden'),

    row('§10 · Validation — MTTD, MTTR and certification'),
    ...certTiles(),
    mttdBars(12, 8),
    mttrBars(12, 8),
    ...certCounts(),

    row('§10 · Validation — synthetic canary and orders flow'),
    ...synthetic(),

    row('§7-8 · Policy and alerting'),
    stat('Symptom alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", burn_rate="", kind=""}) or vector(0)', { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 4 }),
    stat('Burn-rate alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", burn_rate!=""}) or vector(0)', { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 4 }),
    stat('Forecast alerts firing', 'count(ALERTS{alertstate="firing", pack="ibmmq", kind="forecast"}) or vector(0)', { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 4 }),
    alertTimelines(12, 4)[0],
    alertTable(12, 8),
    alertTimelines(12, 8)[1],

    row('§9 · Remediation — runbooks and guardrails'),
    remediationTable(),

    row('Signals — queue manager availability'),
    stat('Queue manager', `max(ibmmq_qmgr_status{${EXP}})`, { desc: `Status as seen by an MQ client over ${chan}.`, mappings: STATE_QMGR, mode: 'solid', thresholds: [{ color: C.red, value: null }, { color: C.green, value: 2 }], w: 4 }),
    ...(hasNative ? [stat('Native endpoint', `max(up{${NAT}})`, { desc: 'Scrape of the queue manager\'s own :9157 endpoint (process alive).', mappings: STATE_UPDOWN, mode: 'solid', thresholds: okBelow(1, 1), w: 4 })] : []),
    stat('Exporter scrape', `max(up{${EXP}})`, { desc: 'Scrape of mq_prometheus (queue/channel detail; dies with the listener).', mappings: STATE_UPDOWN, mode: 'solid', thresholds: okBelow(1, 1), w: 4 }),
    stat('Active listeners', `max(ibmmq_qmgr_active_listeners{${EXP}})`, { decimals: 0, spark: false, thresholds: okBelow(1, 1), w: 4 }),
    stat('Connections', `max(ibmmq_qmgr_connection_count{${EXP}})`, { decimals: 0, mode: 'none', w: 4 }),
    stat('Uptime', `max(ibmmq_qmgr_uptime{${EXP}})`, { unit: 's', decimals: 1, mode: 'none', spark: false, w: 4 }),
    timeline('Availability timeline', [
      ...(hasNative ? [{ expr: `max(up{${NAT}})`, legend: 'process (native endpoint)' }] : []),
      { expr: `max(ibmmq_qmgr_status{${EXP}})`, legend: 'client view (exporter)' },
      { expr: `max(ibmmq_qmgr_command_server_status{${EXP}})`, legend: 'command server' },
      { expr: `max(ibmmq_qmgr_channel_initiator_status{${EXP}})`, legend: 'channel initiator' },
    ], { desc: hasNative ? 'Process alive vs reachable by clients, plus the command server and channel initiator. The differential diagnosis, over time.' : 'Reachable by clients, plus the command server and channel initiator (no native endpoint from this vantage).', mappings: STATE_QMGR, h: 7,
      overrides: [...(hasNative ? [byName('process (native endpoint)', { mappings: STATE_UPDOWN })] : []), byName('command server', { mappings: STATE_SERVICE }), byName('channel initiator', { mappings: STATE_SERVICE })] }),
    ts('Availability ratios · 5 m', [
      ...(hasProcess ? [{ expr: 'ibmmq:qmgr_process_up:ratio_5m', legend: 'process up' }] : []),
      { expr: 'ibmmq:qmgr_reachability:ratio_5m', legend: 'reachable' },
    ], { unit: 'percentunit', min: 0, max: 1, h: 7, colors: { 'process up': C.green, reachable: C.blue }, lines: [{ value: 0.999 }] }),

    row('Signals — queues'),
    bargauge('Headroom by queue · depth / MAXDEPTH', `ibmmq:queue_depth_headroom:ratio{${Q}}`, { legend: '{{queue}}', unit: 'percentunit', max: 1, decimals: 1, thresholds: okAbove(0.8, 1), desc: 'Current depth as a fraction of MAXDEPTH per application queue.', w: 8, h: 8 }),
    ts('Depth by queue', [{ expr: `max by (queue)(ibmmq_queue_depth{${EXP}, ${Q}})`, legend: '{{queue}}' }], { w: 8, h: 8, many: true }),
    ts('Oldest message age by queue', [{ expr: `ibmmq:oldest_message_age:seconds_max{${Q}}`, legend: '{{queue}}' }], { unit: 's', w: 8, h: 8, lines: [{ value: 60 }] }),
    ts('Put / get rate by queue', [
      { expr: `sum by (queue)(sum_over_time(ibmmq_queue_mqput_mqput1_count{${EXP}, ${Q}}[2m])) / 120`, legend: '{{queue}} put/s' },
      { expr: `sum by (queue)(sum_over_time(ibmmq_queue_mqget_count{${EXP}, ${Q}}[2m])) / 120`, legend: '{{queue}} get/s' },
    ], { desc: 'MQI counts are per-interval deltas from the exporter: sum over 2 m ÷ 120 s.', unit: 'ops', many: true }),
    table('Queue snapshot', [
      { expr: `max by (queue)(ibmmq_queue_depth{${EXP}, ${Q}})`, instant: true, format: 'table' },
      { expr: `max by (queue)(ibmmq_queue_attribute_max_depth{${EXP}, ${Q}})`, instant: true, format: 'table' },
      { expr: `max by (queue)(ibmmq_queue_oldest_message_age{${EXP}, ${Q}})`, instant: true, format: 'table' },
      { expr: `max by (queue)(ibmmq_queue_input_handles{${EXP}, ${Q}})`, instant: true, format: 'table' },
      { expr: `max by (queue)(ibmmq_queue_output_handles{${EXP}, ${Q}})`, instant: true, format: 'table' },
    ], { desc: 'Depth, MAXDEPTH, oldest message age and open handles per queue, right now.', h: 7, transformations: [
      { id: 'merge', options: {} },
      { id: 'organize', options: { excludeByName: { Time: true }, renameByName: { queue: 'queue', 'Value #A': 'depth', 'Value #B': 'MAXDEPTH', 'Value #C': 'oldest age (s)', 'Value #D': 'input handles', 'Value #E': 'output handles' } } },
    ], overrides: [byName('oldest age (s)', { 'custom.cellOptions': { type: 'color-background', mode: 'gradient' }, thresholds: { mode: 'absolute', steps: okAbove(60, 120) } }), byName('depth', { 'custom.cellOptions': { type: 'gauge', mode: 'gradient' }, thresholds: { mode: 'absolute', steps: okAbove(80, 160) }, min: 0, max: 200 })] }),
    ts('Open handles by queue · in / out', [
      { expr: `max by (queue)(ibmmq_queue_input_handles{${EXP}, ${Q}})`, legend: '{{queue}} in' },
      { expr: `max by (queue)(ibmmq_queue_output_handles{${EXP}, ${Q}})`, legend: '{{queue}} out' },
    ], { w: 8, h: 6, step: true, decimals: 0 }),
    ts('Queue time · short / long sample', [
      { expr: `max by (queue)(ibmmq_queue_qtime_short{${EXP}, ${Q}})`, legend: '{{queue}} short' },
      { expr: `max by (queue)(ibmmq_queue_qtime_long{${EXP}, ${Q}})`, legend: '{{queue}} long' },
    ], { unit: 'µs', w: 8, h: 6 }),
    ts('Uncommitted messages · expired per 2 m', [
      { expr: `max by (queue)(ibmmq_queue_uncommitted_messages{${EXP}, ${Q}})`, legend: '{{queue}} uncommitted' },
      { expr: `sum by (queue)(sum_over_time(ibmmq_queue_expired_messages{${EXP}, ${Q}}[2m]))`, legend: '{{queue}} expired/2m' },
    ], { w: 8, h: 6, decimals: 0 }),

    row('Signals — channels and connections'),
    timeline('Channel status', [{ expr: `max by (channel, type)(ibmmq_channel_status_squash{${EXP}})`, legend: '{{channel}} ({{type}})' }], { desc: 'Squashed channel status per channel.', mappings: STATE_CHANNEL, h: 6 }),
    ts('Channel instances', [{ expr: `max by (channel)(ibmmq_channel_cur_inst{${EXP}})`, legend: '{{channel}}' }], { desc: 'One instance per client conversation on a SVRCONN channel.', step: true, decimals: 0, h: 6 }),
    ts('Channel messages / s', [{ expr: `sum by (channel)(sum_over_time(ibmmq_channel_messages{${EXP}}[2m])) / 120`, legend: '{{channel}}' }], { desc: 'Per-interval channel message counts, sum over 2 m ÷ 120 s.', unit: 'ops', h: 6 }),
    ts('Channel bytes / s · sent and received', [
      { expr: `sum by (channel)(sum_over_time(ibmmq_channel_bytes_sent{${EXP}}[2m])) / 120`, legend: '{{channel}} sent' },
      { expr: `sum by (channel)(sum_over_time(ibmmq_channel_bytes_rcvd{${EXP}}[2m])) / 120`, legend: '{{channel}} rcvd' },
    ], { unit: 'Bps', h: 6, colors: { '/ sent$/': C.blue, '/ rcvd$/': C.green } }),

    row('Signals — queue manager resources'),
    gauge('User CPU', `max(${qmgrGauge('user_cpu_time_percentage')})`, { thresholds: okAbove(70, 90) }),
    gauge('RAM free', `max(${qmgrGauge('ram_free_percentage')})`, { thresholds: okBelow(20, 10) }),
    gauge('Queue manager filesystem free', `max(${qmgrGauge('queue_manager_file_system_free_space_percentage')})`, { thresholds: okBelow(25, 15) }),
    gauge('Log filesystem free', `max(${qmgrGauge('log_file_system_free_space_percentage')})`, { thresholds: okBelow(25, 15) }),
    gauge('Log primary space in use', `max(${qmgrGauge('log_primary_space_in_use_percentage')})`, { thresholds: okAbove(70, 90) }),
    stat('Log write latency', `max(${qmgrGauge('log_write_latency_seconds')})`, { unit: 's', decimals: 1, thresholds: okAbove(0.02, 0.05), w: 4, h: 5 }),
    ts('CPU · user / system', [
      { expr: `max(${qmgrGauge('user_cpu_time_percentage')})`, legend: 'user' },
      { expr: `max(${qmgrGauge('system_cpu_time_percentage')})`, legend: 'system' },
    ], { unit: 'percent', min: 0, h: 6, colors: { user: C.blue, system: C.violet }, stack: true }),
    ts('MQI calls / s', [
      { expr: `sum(${qmgrCounter('mqput_mqput1_total')})`, legend: 'mqput' },
      { expr: `sum(${qmgrCounter('destructive_get_total')})`, legend: 'destructive get' },
      { expr: `sum(${qmgrCounter('commit_total')})`, legend: 'commit' },
      { expr: `sum(${qmgrCounter('rollback_total')})`, legend: 'rollback' },
      { expr: `sum(${qmgrCounter('mqconn_mqconnx_total')})`, legend: 'connect' },
    ], { unit: 'ops', h: 6, colors: { mqput: C.blue, 'destructive get': C.green, commit: C.violet, rollback: C.red, connect: C.cyan } }),
    ts('Failed MQI calls / s · expired messages', [
      { expr: `sum(${qmgrCounter('failed_mqput_total')})`, legend: 'failed mqput' },
      { expr: `sum(${qmgrCounter('failed_mqget_total')})`, legend: 'failed mqget' },
      { expr: `sum(${qmgrCounter('failed_mqopen_total')})`, legend: 'failed mqopen' },
      { expr: `sum(${qmgrCounter('failed_mqconn_mqconnx_total')})`, legend: 'failed connect' },
      { expr: `sum(${qmgrCounter('expired_message_total')})`, legend: 'expired' },
    ], { unit: 'ops', h: 6, colors: { 'failed mqput': C.red, 'failed mqget': C.amber, 'failed mqopen': C.pink, 'failed connect': C.violet, expired: C.slate } }),
    ts('Puts / s · persistent vs non-persistent', [
      { expr: `sum(${qmgrCounter('persistent_message_mqput_total')} + ${qmgrCounter('persistent_message_mqput1_total')})`, legend: 'persistent' },
      { expr: `sum(${qmgrCounter('non_persistent_message_mqput_total')} + ${qmgrCounter('non_persistent_message_mqput1_total')})`, legend: 'non-persistent' },
    ], { unit: 'ops', h: 6, colors: { persistent: C.violet, 'non-persistent': C.cyan }, stack: true }),
    ts('Recovery log written / s · logical vs physical', [
      { expr: `sum(${qmgrCounter('log_logical_written_bytes_total')})`, legend: 'logical' },
      { expr: `sum(${qmgrCounter('log_physical_written_bytes_total')})`, legend: 'physical' },
    ], { unit: 'Bps', h: 6, colors: { logical: C.blue, physical: C.violet } }),
    ts('Recovery log · write latency and space in use', [
      { expr: `max(${qmgrGauge('log_write_latency_seconds')})`, legend: 'write latency' },
      { expr: `max(${qmgrGauge('log_in_use_bytes')}) / max(${qmgrGauge('log_max_bytes')})`, legend: 'in use / max' },
    ], { unit: 's', decimals: 1, h: 6, colors: { 'write latency': C.amber, 'in use / max': C.blue }, axisRight: [{ name: 'in use / max', unit: 'percentunit', min: 0, max: 1 }] }),

    row('§3-5 · Pipelines, storage and queries'),
    stat('TSDB series', 'max(prometheus_tsdb_head_series)', { desc: 'Active series in Prometheus (2 d retention in the lab).', decimals: 0, mode: 'none', w: 4, h: 5 }),
    stat('Samples appended / s', 'sum(rate(prometheus_tsdb_head_samples_appended_total[2m]))', { unit: 'ops', decimals: 0, mode: 'none', w: 4, h: 5 }),
    stat('Recording rules producing', 'count(count by (__name__)({__name__=~"ibmmq:.*"}))', { desc: 'Distinct ibmmq:* recording-rule series currently produced (pack queries + generated error-budget rules).', decimals: 0, mode: 'none', spark: false, w: 4, h: 5 }),
    ts('Scrape duration by MQ job', [{ expr: 'max by (job)(scrape_duration_seconds{job=~"ibmmq-.*|certification"})', legend: '{{job}}' }], { unit: 's', w: 12, h: 5, colors: { ...(hasNative ? { 'ibmmq-native': C.green } : {}), 'ibmmq-exporter': C.blue, certification: C.slate } }),
    ts('Collector · exported per second', [
      { expr: 'sum by (exporter)(rate(otelcol_exporter_sent_metric_points_total[2m]))', legend: 'metric points → {{exporter}}' },
      { expr: 'sum by (exporter)(rate(otelcol_exporter_sent_log_records_total[2m]))', legend: 'log records → {{exporter}}' },
      { expr: 'sum by (exporter)(rate(otelcol_exporter_sent_spans_total[2m]))', legend: 'spans → {{exporter}}' },
    ], { unit: 'ops', h: 6, colors: { '/^metric points/': C.blue, '/^log records/': C.green, '/^spans/': C.violet } }),
    ts('Collector · export failures per second', [
      { expr: 'sum by (exporter)(rate(otelcol_exporter_send_failed_metric_points_total[2m])) or vector(0)', legend: 'metric points {{exporter}}' },
      { expr: 'sum by (exporter)(rate(otelcol_exporter_send_failed_log_records_total[2m])) or vector(0)', legend: 'log records {{exporter}}' },
      { expr: 'sum by (exporter)(rate(otelcol_exporter_send_failed_spans_total[2m])) or vector(0)', legend: 'spans {{exporter}}' },
    ], { desc: 'The failure counters only exist once a batch has failed; a flat zero is the collector saying nothing has.', unit: 'ops', h: 6, colors: { '/.*/': C.red } }),

    row('Logs and traces'),
    logs('Logs · queue manager and apps', `{${LOGSVC}}`, { desc: 'Filter with the "Log service" variable. App lines carry trace_id / span_id; click a line to jump to its trace.', h: 10 }),
    traces('Recent traces · producer → consumer through MQ', '{ resource.service.name =~ "mq-canary|orders-producer|orders-consumer" }', { desc: 'Open a consumer "receive" span: its link points at the producer trace whose context travelled in the message properties.', h: 8 }),
  ], ['ibmmq', 'pack', 'unified'], {
    description: `Everything about ${where} on one board, in the pack\'s order: SLIs and SLOs, MTTD/MTTR and certification, policy and alerting, remediation, signals, pipeline, logs and traces.`,
    time: { from: 'now-3h', to: 'now' },
    templating: { list: [
      { name: 'queue', label: 'Queue', type: 'query', datasource: DS, refresh: 2, sort: 1, multi: true, includeAll: true, allValue: '.*',
        query: { query: 'label_values(ibmmq_queue_depth{job="ibmmq-exporter"}, queue)', refId: 'StandardVariableQuery' },
        definition: 'label_values(ibmmq_queue_depth{job="ibmmq-exporter"}, queue)', current: { text: 'All', value: '$__all', selected: true }, options: [] },
      // Options come from Loki (every service the collector names); "All" means the four MQ services.
      { name: 'service', label: 'Log service', type: 'query', datasource: LOKI, refresh: 2, sort: 1, multi: true, includeAll: true,
        allValue: 'ibmmq|mq-canary|orders-producer|orders-consumer',
        query: { label: 'service_name', refId: 'LokiVariableQueryEditor-VariableQuery', stream: '', type: 1 },
        definition: 'label_values(service_name)', current: { text: 'All', value: '$__all', selected: true }, options: [] },
    ] },
  });

  return [
    { id: 'ibmmq-overview', file: 'ibmmq-overview.json', dashboard: overview },
    { id: 'ibmmq-queues', file: 'ibmmq-queues.json', dashboard: queues },
    { id: 'ibmmq-slo-burn', file: 'ibmmq-slo-burn.json', dashboard: sloBurn },
    { id: 'ibmmq-unified', file: 'ibmmq-unified.json', dashboard: unified },
  ];
}
