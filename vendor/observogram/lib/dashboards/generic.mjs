// Generic dashboards from any ObservabilityPack: one board per `spec.dashboards[]` entry, laid
// out in the pack's own section order (contract → validation → policy and alerting →
// remediation → pack-specific signals → pipelines → logs and traces). Boards with `source:`
// get the panels their `panel_bindings` declare (SLI tiles, error-budget burn for bound SLOs,
// per-resource rollups for bound derived views); `template: ref:platform/slo-burn-template`
// becomes a real burn board for `params.slos`; `ref:platform/per-resource-template` a board
// for `params.view`. A pack module (tools/gen-dashboards.mjs --module) can add signal rows per
// board id or replace the derived SLI tiles with hand-written ones.
import {
  configure, ctx, humanize, row, text, stat, ts, logs, traces, header, dashboard, resetIds,
  derivedSliTiles, derivedViewPanel, burnBars, burnCurves, burnThresholds, alertTimelines, alertTable, alertCounters,
  certTiles, mttdBars, mttrBars, certCounts, remediationTable, okAbove, C, DS,
} from './lib.mjs';

const basename = (p) => String(p).replace(/^file:\/\//, '').split('/').pop();
/** "grafana-alerting-health" → "Alerting health" (the pack name prefix is dropped). */
export function titleOf(pack, d) {
  const id = String(d.id).replace(new RegExp(`^${pack.metadata.name}[-_]`), '');
  return humanize(id);
}
function bindings(d) {
  const out = { slis: [], slos: [], views: [] };
  for (const b of d.panel_bindings || []) {
    const t = String(b.binds_to);
    let m;
    if ((m = /^slis\.(.+)$/.exec(t))) out.slis.push(m[1]);
    else if ((m = /^slos\.(.+)$/.exec(t))) out.slos.push(m[1]);
    else if ((m = /^ref:queries\.(.+)$/.exec(t))) out.views.push(m[1]);
  }
  return out;
}
const scrapeJobs = (pack) => (pack.spec.pipelines?.receivers || []).flatMap(r => (r.scrape_configs || []).map(s => s.job_name)).filter(Boolean);
const backendProducts = (pack) => new Set((pack.spec.telemetry?.backends || []).map(b => b.product));

function pipelinesPanels(pack) {
  const svc = pack.metadata.name;
  const jobs = scrapeJobs(pack);
  return [
    row('§3-5 · Pipelines, storage and queries'),
    stat('TSDB series', 'max(prometheus_tsdb_head_series)', { desc: 'Active series in the metrics store.', decimals: 0, mode: 'none', w: 4, h: 5 }),
    stat('Samples appended / s', 'sum(rate(prometheus_tsdb_head_samples_appended_total[2m]))', { unit: 'ops', decimals: 0, mode: 'none', w: 4, h: 5 }),
    stat('Recording rules producing', `count(count by (__name__)({__name__=~"${svc}:.*"}))`, { desc: `Distinct ${svc}:* recording-rule series currently produced (pack queries + generated error-budget rules).`, decimals: 0, mode: 'none', spark: false, w: 4, h: 5 }),
    ts('Scrape duration by job', [{ expr: jobs.length ? `max by (job)(scrape_duration_seconds{job=~"${jobs.join('|')}"})` : 'max by (job)(scrape_duration_seconds)', legend: '{{job}}' }], { desc: jobs.length ? `The pack's scrape jobs: ${jobs.join(', ')}.` : 'Every scrape job.', unit: 's', w: 12, h: 5 }),
    ts('Collector · exported per second', [
      { expr: 'sum by (exporter)(rate(otelcol_exporter_sent_metric_points_total[2m]))', legend: 'metric points → {{exporter}}' },
      { expr: 'sum by (exporter)(rate(otelcol_exporter_sent_log_records_total[2m]))', legend: 'log records → {{exporter}}' },
      { expr: 'sum by (exporter)(rate(otelcol_exporter_sent_spans_total[2m]))', legend: 'spans → {{exporter}}' },
    ], { desc: 'OpenTelemetry Collector export throughput (present when the pack pipeline runs through a collector).', unit: 'ops', h: 6, colors: { '/^metric points/': C.blue, '/^log records/': C.green, '/^spans/': C.violet } }),
    ts('Collector · export failures per second', [
      { expr: 'sum by (exporter)(rate(otelcol_exporter_send_failed_metric_points_total[2m])) or vector(0)', legend: 'metric points {{exporter}}' },
      { expr: 'sum by (exporter)(rate(otelcol_exporter_send_failed_log_records_total[2m])) or vector(0)', legend: 'log records {{exporter}}' },
      { expr: 'sum by (exporter)(rate(otelcol_exporter_send_failed_spans_total[2m])) or vector(0)', legend: 'spans {{exporter}}' },
    ], { desc: 'The failure counters only exist once a batch has failed; a flat zero is the collector saying nothing has.', unit: 'ops', h: 6, colors: { '/.*/': C.red } }),
  ];
}
function logsTracesPanels(pack) {
  const svc = pack.metadata.name, products = backendProducts(pack), out = [row('Logs and traces')];
  if (products.has('loki')) out.push(logs('Logs', `{service_name="${svc}"}`, { desc: `Log lines the collector labelled service_name="${svc}".`, h: 9 }));
  if (products.has('tempo')) out.push(traces('Recent traces', `{ resource.service.name = "${svc}" }`, { desc: `Traces whose resource is the ${svc} service.`, h: 8 }));
  if (out.length === 1) {
    const declared = [...products].filter(p => ['elasticsearch', 'opensearch', 'jaeger', 'splunk'].includes(p));
    out.push(text(`The pack declares ${declared.length ? declared.join(', ') : 'no Loki or Tempo backend'} for logs and traces; this generator renders Loki and Tempo panels only.`, { title: 'Logs and traces', h: 3 }));
  }
  return out;
}
const sloTiles = (pack, sloIds) => { const c = ctx(); return pack.spec.slos.filter(s => sloIds.includes(s.id)).map(s =>
  stat(`${c.sloRename[s.id]} · burn 1 h`, `${c.svc}:errorbudget:burn_1h{slo="${s.id}"}`, { binds: `slos.${s.id}`, desc: `1 h burn rate of ${c.sloLabel[s.id]} (objective ${s.objective} over ${s.window}).`, decimals: 1, thresholds: burnThresholds(s.id), w: sloIds.length <= 6 ? 4 : 3 })); };

/**
 * Build every board a pack declares. Returns [{ id, file, dashboard }]. `module` may provide
 * `sliTiles(pack, sliIds)` (hand-written tiles), `signals[boardId]` (extra panels, inserted after
 * remediation) and `configure` overrides (displayName, sloLabel, certSel, repoUrl).
 */
export function genericBoards(pack, { module = null, repoUrl = null } = {}) {
  const dashboards = pack.spec.dashboards || [];
  const overrides = module?.configure ? module.configure(pack) : {};
  configure({ pack, repoUrl, ...overrides, boards: dashboards.map(d => [d.id, titleOf(pack, d)]) });
  const c = ctx();
  const chaos = pack.spec.validation?.chaos_experiments || [];
  const views = Object.fromEntries((pack.spec.queries?.derived_views || []).map(v => [v.id, v]));
  const tiles = (ids) => (module?.sliTiles ? module.sliTiles(pack, ids) : derivedSliTiles(pack, ids, { w: ids.length <= 6 ? 4 : 3 }));
  const primaryId = dashboards.find(d => d.source)?.id;
  const out = [];
  for (const d of dashboards) {
    resetIds();
    const title = titleOf(pack, d);
    const tags = [pack.metadata.name, 'pack'];
    if (d.source) {
      const b = bindings(d), primary = d.id === primaryId;
      const blurb = [b.slis.length ? `SLIs ${b.slis.join(', ')}` : null, b.slos.length ? `SLOs ${b.slos.join(', ')}` : null, b.views.length ? `views ${b.views.join(', ')}` : null].filter(Boolean).join(' · ') || 'Pack-declared board.';
      const panels = [
        header(title, `${blurb}.`, d.id),
        ...(b.slis.length || b.slos.length ? [row('§1-2 · Contract — SLIs and SLOs'), ...tiles(b.slis)] : []),
        ...(b.slos.length ? [burnBars(b.slos.map(s => `slos.${s}`), 12, 8, b.slos), ...burnCurves(6, 'hidden')] : []),
        ...(b.views.length ? [row('§5 · Derived views'), ...b.views.map(v => (views[v] ? derivedViewPanel(pack, views[v], `ref:queries.${v}`) : text(`Derived view \`${v}\` is bound but not declared in spec.queries.derived_views.`, { title: humanize(v), h: 3 })))] : []),
        ...(primary && chaos.length ? [row('§10 · Validation — MTTD, MTTR and certification'), ...certTiles(), mttdBars(12, 8), mttrBars(12, 8), ...certCounts()] : []),
        ...(primary ? [row('§7-8 · Policy and alerting'), ...alertCounters(4), alertTimelines(12, 4)[0], alertTable(12, 8), alertTimelines(12, 8)[1]] : [row('Alerting'), ...alertTimelines(12, 6)]),
        ...(primary && (pack.spec.remediation || []).length ? [row('§9 · Remediation — runbooks and guardrails'), remediationTable()] : []),
        ...(module?.signals?.[d.id] || []),
        ...(primary ? [...pipelinesPanels(pack), ...logsTracesPanels(pack)] : []),
      ];
      out.push({ id: d.id, file: basename(d.source), dashboard: dashboard(d.id, `${c.displayName} — ${title}`, panels, [...tags, ...(primary ? ['overview'] : [])], { description: `${c.displayName} pack board "${title}": ${blurb}.`, time: { from: primary ? 'now-3h' : 'now-1h', to: 'now' } }) });
      continue;
    }
    const tpl = String(d.template || '');
    if (/slo-burn-template$/.test(tpl)) {
      const sloIds = (d.params?.slos || []).filter(id => pack.spec.slos.some(s => s.id === id));
      const panels = [
        header(title, 'Error-budget burn per SLO on the fast and slow windows, and the burn-rate / forecast alert history.', d.id),
        ...sloTiles(pack, sloIds),
        burnBars(null, 12, 8, sloIds),
        alertTimelines(12, 8)[1],
        ...burnCurves(12),
        ts('Error ratio · 5 m, per SLI', [{ expr: `{__name__=~"${c.svc}:.*:error_ratio_5m"}`, legend: '{{__name__}}' }], { desc: 'Bad samples over expected samples in the last 5 minutes, per SLI.', unit: 'percentunit', many: true, rename: Object.fromEntries(pack.spec.slis.map(s => [`${c.svc}:${s.id}:error_ratio_5m`, s.id])) }),
        stat('Burn-rate alerts firing', `count(ALERTS{alertstate="firing", pack="${c.packName}", burn_rate!=""}) or vector(0)`, { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 6, h: 7 }),
        stat('Forecast alerts firing', `count(ALERTS{alertstate="firing", pack="${c.packName}", kind="forecast"}) or vector(0)`, { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 6, h: 7 }),
      ];
      out.push({ id: d.id, file: `${d.id}.json`, dashboard: dashboard(d.id, `${c.displayName} — ${title}`, panels, [...tags, 'slo'], { description: `Multi-window burn rates and forecasts for ${sloIds.length} ${c.displayName} SLOs.` }) });
      continue;
    }
    if (/per-resource-template$/.test(tpl)) {
      const v = views[d.params?.view];
      const panels = [header(title, v ? `Per-resource rollup ${v.id}.` : 'Per-resource rollup.', d.id), v ? derivedViewPanel(pack, v, `ref:queries.${v.id}`) : text(`Derived view \`${d.params?.view}\` is not declared in spec.queries.derived_views.`, { title, h: 3 })];
      out.push({ id: d.id, file: `${d.id}.json`, dashboard: dashboard(d.id, `${c.displayName} — ${title}`, panels, tags, { description: `${c.displayName} per-resource view.` }) });
      continue;
    }
    out.push({ id: d.id, file: `${d.id}.json`, dashboard: dashboard(d.id, `${c.displayName} — ${title}`, [header(title, `Template ${tpl || '(none)'} is not one this generator renders.`, d.id)], tags, { description: `Unrendered template ${tpl}.` }), skipped: tpl });
  }
  return out;
}

/** Every `panel_bindings[].binds_to` of a source dashboard must be bound by a panel; uid must equal id. */
export function checkBindings(pack, boards) {
  const problems = [];
  for (const d of pack.spec.dashboards || []) {
    const b = boards.find(x => x.id === d.id);
    if (!b) { problems.push(`${d.id}: not generated`); continue; }
    if (b.dashboard.uid !== d.id) problems.push(`${d.id}: uid ${b.dashboard.uid}`);
    const panels = (b.dashboard.panels || []).flatMap(p => [p, ...(p.panels || [])]);
    const bound = new Set(panels.flatMap(p => (Array.isArray(p.pack?.binds_to) ? p.pack.binds_to : [])));
    const wanted = d.source ? (d.panel_bindings || []).map(x => x.binds_to) : /slo-burn-template$/.test(String(d.template || '')) ? (d.params?.slos || []).map(s => `slos.${s}`) : [];
    for (const w of wanted) if (!bound.has(w)) problems.push(`${d.id}: no panel bound to ${w}`);
    for (const p of panels) for (const t of p.targets || []) if (/undefined|NaN/.test(String(t.expr || t.query || ''))) problems.push(`${d.id}: panel "${p.title}" has a malformed target`);
  }
  return problems;
}
export { DS };
