// Conformance: does the running stack implement what the pack declares?
// Every check returns { id, title, status: PASS|FAIL|WARN, detail, evidence }.
import { cfg, ping, promQuery, promRules, promTargets, lokiQuery, tempoServices, tempoTraces, grafana, getJSON, waitFor } from '../lib/http.mjs';
import { sliExpr, recordingRuleNames, referencedAlerts, alertKey } from '../lib/pack.mjs';

const R = (id, title, status, detail, evidence) => ({ id, title, status, detail, evidence });

export async function conformance(pack) {
  const out = [];

  // C1 — component health
  const components = [
    ['prometheus', `${cfg.prom}/-/ready`], ['alertmanager', `${cfg.am}/-/ready`], ['alert-sink', `${cfg.sink}/healthz`],
    ['loki', `${cfg.loki}/ready`], ['tempo', `${cfg.tempo}/ready`], ['grafana', `${cfg.grafana}/api/health`], ['otel-collector', `${cfg.otelcol}/`],
  ];
  // Wait for readiness (up to 6 min, all components in parallel) instead of pinging once:
  // Loki 3.x on this single-binary config answers /ready only ~4-5 min after start, Tempo
  // ~15 s. Time-to-ready is recorded per component as evidence.
  const health = await Promise.all(components.map(async ([name, url]) => {
    const r = await waitFor(() => ping(url), { timeoutMs: 360000, intervalMs: 5000, label: `${name} ready` });
    return { name, url, up: !!r.value, readyAfterMs: r.value ? r.elapsedMs : null };
  }));
  const down = health.filter(h => !h.up).map(h => h.name);
  const slow = health.filter(h => h.up && h.readyAfterMs > 10000).map(h => `${h.name} ready after ${(h.readyAfterMs / 1000).toFixed(0)}s`);
  out.push(R('C1', 'Telemetry stack components healthy', down.length ? 'FAIL' : 'PASS',
    down.length ? `down after 6 min: ${down.join(', ')}` : `${health.length}/${health.length} components answer${slow.length ? ` (${slow.join(', ')})` : ''}`, health));

  // C2 — both MQ scrape sources up
  const targets = await promTargets();
  const native = await promQuery('up{job="ibmmq-native"}');
  const exporter = await promQuery('up{job="ibmmq-exporter"}');
  const nUp = native.result.filter(r => r.value[1] === '1').length;
  const eUp = exporter.result.filter(r => r.value[1] === '1').length;
  out.push(R('C2', 'Queue manager scraped from native endpoint AND client-side exporter',
    nUp && eUp ? 'PASS' : 'FAIL', `ibmmq-native up=${nUp}, ibmmq-exporter up=${eUp}`,
    { native: native.result, exporter: exporter.result, prometheusSelfTargets: targets.map(t => ({ job: t.labels.job, health: t.health })) }));

  // C3 — every SLI query evaluates to at least one sample
  const sliRows = [];
  for (const sli of pack.spec.slis) {
    const expr = sliExpr(sli);
    const q = await promQuery(expr);
    const n = q.result.length;
    const v = n ? Number(q.result[0].value[1]) : null;
    sliRows.push({ id: sli.id, type: sli.type, samples: n, value: v, threshold: sli.threshold ?? null, unit: sli.unit ?? 'ratio', ok: q.ok && n > 0, error: q.error, expr });
  }
  const badSli = sliRows.filter(r => !r.ok);
  out.push(R('C3', 'Every pack SLI resolves against live data', badSli.length ? 'FAIL' : 'PASS',
    badSli.length ? `no data: ${badSli.map(r => r.id).join(', ')}` : `${sliRows.length}/${sliRows.length} SLIs return samples`, sliRows));

  // C4 — recording rules loaded and producing
  const rules = await promRules();
  const recNames = new Set(rules.filter(r => r.type === 'recording').map(r => r.name));
  const recRows = [];
  for (const name of recordingRuleNames(pack)) {
    const loaded = recNames.has(name);
    const q = loaded ? await promQuery(name) : { result: [] };
    recRows.push({ name, loaded, samples: q.result.length, ok: loaded && q.result.length > 0 });
  }
  const badRec = recRows.filter(r => !r.ok);
  out.push(R('C4', 'Pack recording rules loaded in Prometheus and yielding samples', badRec.length ? 'FAIL' : 'PASS',
    badRec.length ? `missing/empty: ${badRec.map(r => r.name).join(', ')}` : `${recRows.length}/${recRows.length} rules healthy`, recRows));

  // C5 — alert rules referenced by the pack exist and are healthy
  const alertRules = rules.filter(r => r.type === 'alerting');
  const byKey = new Map(alertRules.map(r => [alertKey(r.name), r]));
  const refRows = [];
  for (const [key, asWritten] of referencedAlerts(pack)) {
    const rule = byKey.get(key);
    refRows.push({ referenced: asWritten, alertname: rule?.name ?? null, present: !!rule, health: rule?.health ?? null, severity: rule?.labels?.severity ?? null, ok: !!rule && rule.health === 'ok' });
  }
  const badRef = refRows.filter(r => !r.ok);
  out.push(R('C5', 'Alerts referenced by the pack (chaos + remediation) exist as Prometheus rules', badRef.length ? 'FAIL' : 'PASS',
    badRef.length ? `missing/unhealthy: ${badRef.map(r => r.referenced).join(', ')}` : `${refRows.length}/${refRows.length} referenced alerts present; ${alertRules.length} alert rules loaded in total`,
    { referenced: refRows, loaded: alertRules.map(r => ({ name: r.name, severity: r.labels?.severity, health: r.health, state: r.state })) }));

  // C6 — metric catalogue: the ibmmq_* families the SLIs depend on
  const families = [
    ['ibmmq_qmgr_status', 'ibmmq-exporter'], ['ibmmq_queue_depth', 'ibmmq-exporter'], ['ibmmq_queue_attribute_max_depth', 'ibmmq-exporter'],
    ['ibmmq_queue_oldest_message_age', 'ibmmq-exporter'], ['ibmmq_qmgr_log_write_latency_seconds', 'ibmmq-exporter'],
    ['ibmmq_channel_status_squash', 'ibmmq-exporter'], ['ibmmq_qmgr_connection_count', 'ibmmq-exporter'],
    ['ibmmq_qmgr_commit_total', 'ibmmq-native'], ['mq_canary_attempts_total', null], ['mq_canary_roundtrip_duration_seconds_bucket', null],
  ];
  const famRows = [];
  for (const [name, job] of families) {
    const q = await promQuery(job ? `count(${name}{job="${job}"})` : `count(${name})`);
    const n = q.result.length ? Number(q.result[0].value[1]) : 0;
    famRows.push({ metric: name, job, series: n, ok: n > 0 });
  }
  const famBad = famRows.filter(r => !r.ok);
  const allIbm = await promQuery('count({__name__=~"ibmmq_.*"}) by (__name__)');
  out.push(R('C6', 'Required metric families present', famBad.length ? 'FAIL' : 'PASS',
    famBad.length ? `absent: ${famBad.map(r => r.metric).join(', ')}` : `${famRows.length}/${famRows.length} families present; ${allIbm.result.length} distinct ibmmq_* metric names in TSDB`,
    { required: famRows, ibmmqMetricNames: allIbm.result.map(r => r.metric.__name__).sort() }));

  // C7 — dashboards + datasources provisioned in Grafana
  const dashRows = [];
  for (const d of pack.spec.dashboards) {
    if (!d.source) { dashRows.push({ id: d.id, templated: true, ok: true, note: 'template-bound (platform ref), not provisioned in lab' }); continue; }
    const r = await grafana(`/api/dashboards/uid/${d.id}`);
    dashRows.push({ id: d.id, ok: r.ok, title: r.body?.dashboard?.title ?? null, panels: r.body?.dashboard?.panels?.length ?? 0, folder: r.body?.meta?.folderTitle ?? null });
  }
  // Grafana's /health endpoint is not implemented by every core datasource plugin (the
  // Alertmanager datasource answers 500 "Plugin unavailable" on 12.4). When /health is not OK,
  // fall back to a real request through Grafana's datasource proxy: that proves the
  // provisioning and the connectivity the panels actually rely on.
  const probe = { prom: '/api/v1/status/buildinfo', loki: '/ready', tempo: '/api/echo', alertmanager: '/api/v2/status' };
  const dsRows = [];
  for (const uid of ['prom', 'loki', 'tempo', 'alertmanager']) {
    const h = await grafana(`/api/datasources/uid/${uid}/health`);
    let ok = h.ok && h.body?.status === 'OK', via = 'health';
    if (!ok) { const p = await grafana(`/api/datasources/proxy/uid/${uid}${probe[uid]}`); ok = p.ok; via = `proxy ${probe[uid]} -> HTTP ${p.status}`; }
    dsRows.push({ uid, ok, via, status: h.body?.status ?? h.status, message: h.body?.message ?? null });
  }
  const dashBad = dashRows.filter(r => !r.ok), dsBad = dsRows.filter(r => !r.ok);
  out.push(R('C7', 'Grafana dashboards provisioned and datasources healthy', dashBad.length || dsBad.length ? 'FAIL' : 'PASS',
    `${dashRows.filter(r => r.ok).length}/${dashRows.length} dashboards, ${dsRows.filter(r => r.ok).length}/${dsRows.length} datasources`, { dashboards: dashRows, datasources: dsRows }));

  // C8 — logs: MQ console JSON parsed and labelled in Loki
  // 6 h window for the queue manager: it is nearly silent at steady state (a handful of
  // lines per hour), whereas the apps log every few seconds (30 min window below).
  const lq = await lokiQuery('{service_name="ibmmq"}', { minutes: 360, limit: 20 });
  const lines = lq.streams.reduce((n, s) => n + (s.values?.length || 0), 0);
  const sample = lq.streams[0]?.values?.[0]?.[1] ?? null;
  const labels = lq.streams[0]?.stream ?? null;
  const appq = await lokiQuery('{service_name=~"mq-canary|orders-producer|orders-consumer"} |= "trace_id"', { minutes: 30, limit: 5 });
  const appLines = appq.streams.reduce((n, s) => n + (s.values?.length || 0), 0);
  out.push(R('C8', 'Queue manager logs in Loki (parsed MQ JSON) + app logs carry trace_id', lines > 0 && appLines > 0 ? 'PASS' : (lines > 0 || appLines > 0 ? 'WARN' : 'FAIL'),
    `${lines} qmgr log lines in last 6h, ${appLines} trace-correlated app lines in last 30m`, { qmgrLabels: labels, qmgrSample: sample, appSample: appq.streams[0]?.values?.[0]?.[1] ?? null, error: lq.error }));

  // C9 — traces: services present in Tempo and consumer receive spans carry an OTLP span link
  // to the producer's trace (the ibmmq module adds the link from the traceparent it finds in
  // the message properties; see canary/src/mq.mjs get()).
  const services = await tempoServices();
  const want = ['mq-canary', 'orders-producer', 'orders-consumer'];
  const missing = want.filter(s => !services.includes(s));
  let linked = 0, consumerSpans = 0, linkExample = null;
  const traces = await tempoTraces('{ resource.service.name = "orders-consumer" && name =~ ".*receive" }', { limit: 30 });
  for (const t of traces) for (const rs of t.resourceSpans) for (const ss of (rs.scopeSpans || rs.instrumentationLibrarySpans || [])) for (const s of (ss.spans || [])) {
    if (!/receive$/.test(s.name || '')) continue;
    consumerSpans++;
    const link = (s.links || []).find(l => l.traceId && l.traceId !== s.traceId);
    if (link) { linked++; linkExample ||= { consumerTrace: t.traceID, linkedProducerTraceId: link.traceId, linkedProducerSpanId: link.spanId }; }
  }
  const propagationOk = consumerSpans > 0 && linked > 0;
  out.push(R('C9', 'Traces: canary/producer/consumer services in Tempo; W3C context propagated through MQ message properties',
    missing.length ? 'FAIL' : (propagationOk ? 'PASS' : 'WARN'),
    missing.length ? `services missing: ${missing.join(', ')}` : `${services.length} services; ${linked}/${consumerSpans} consumer receive spans link to a producer trace`,
    { services, consumerSpans, linked, linkExample }));

  // C10 — collector export health (informational)
  const failed = await promQuery('sum({__name__=~"otelcol_exporter_send_failed_(metric_points|spans|log_records)(_total)?"}) by (__name__, exporter)');
  const sent = await promQuery('sum({__name__=~"otelcol_exporter_sent_(metric_points|spans|log_records)(_total)?"}) by (__name__, exporter)');
  const anyFailed = failed.result.some(r => Number(r.value[1]) > 0);
  out.push(R('C10', 'OTel Collector export counters (sent vs failed)', sent.result.length ? (anyFailed ? 'WARN' : 'PASS') : 'WARN',
    `${sent.result.length} sent-series, failed>0: ${anyFailed}`, { sent: sent.result, failed: failed.result }));

  return out;
}
