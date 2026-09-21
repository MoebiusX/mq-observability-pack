// tools/site/ibmmq.mjs — the IBM MQ module of gen-site (design §4).
//
// Everything pack-specific the generic core (vendor/observogram/lib/site/run.mjs) needs to
// render one partition per environment from packs/ibmmq.pack.yaml and a site inventory:
//
//   paramsSchema          the site / host / instance parameter fragments of the inventory (§2.1)
//   packSubstitutions     exact-count text anchors over the reference pack (§6); under the lab
//                         inventory every anchor maps a value to itself, so the lab site pack is
//                         byte-identical to the reference pack (tools/test-site.mjs T10)
//   packRemovals          the degraded set for vantage single (§8) and the orders-flow synthetic
//                         check when the environment has no orders queue
//   runbooks              the RUNBOOK map of tools/gen-burn-rules.mjs
//   templates / perQmgr   delegated to the registry tools/site/templates/index.mjs
//   boards / dashboardOptions   the four boards through tools/gen-dashboards.mjs
//   harness               what a certification harness reads from site.json (families,
//                         services, vantage, profile, probe, names)
//   checks                self-checks over the emitted files (§9.3)
//   fleet                 files at <out>/ for --env all (nothing yet)
//
// Rule 7 (CLAUDE.md): the lab literals stay the defaults; every other environment gets the
// timing model's values (ctx.timing, vendor/observogram/lib/site/timing.mjs).

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from '../../vendor/observogram/lib/mini-yaml.mjs';
import { RUNBOOK } from '../gen-burn-rules.mjs';
import { generateDashboards } from '../gen-dashboards.mjs';
import * as registry from './templates/index.mjs';
import { promqlString } from './templates/lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REFERENCE_ALERTS = 'stack/prometheus/rules/ibmmq.alerts.yml';
const list = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- 2.1 what an instance is
// The core calls them instances; this module calls them queue managers: the inventory lists
// them under `queue_managers:`, the expected sets and the inventory series use the kind `qmgr`
// (ibmmq:inventory:qmgr, the label every MQ series carries), and `shape` is required with the
// five MQ shapes.
export const instances = {
  key: 'queue_managers',
  kind: 'qmgr',
  label: 'qmgr',
  title: 'queue manager',
  schema: {
    required: ['shape'],
    properties: { shape: { type: 'string', enum: ['container', 'host', 'multi-instance', 'rdqm-ha', 'rdqm-dr'] } },
  },
};

// ---------------------------------------------------------------- 2.1 module params
const DURATION = { type: 'string', pattern: '^[0-9]+(ms|s|m|h)$' };
const NAME = { type: 'string', minLength: 1 };
const PORT = { type: 'integer', minimum: 1, maximum: 65535 };
const nullable = (schema) => ({ ...schema, type: [schema.type, 'null'] });

export const paramsSchema = {
  site: {
    type: 'object',
    required: ['app_queue_pattern', 'monitored_queues', 'deadq', 'canary_queue', 'users', 'monitoring_host', 'log_source'],
    additionalProperties: false,
    properties: {
      app_queue_pattern: NAME,                                   // PromQL regex of the application queues (queue=~"…")
      monitored_queues: { type: 'array', minItems: 1, items: NAME },   // mq_prometheus objects.queues patterns
      deadq: NAME,                                               // the queue manager's DEADQ
      canary_queue: NAME,
      orders_queue: nullable(NAME),                              // null: no orders flow (S4 dropped)
      burst_queue: nullable(NAME),                               // null: no queue-full experiment target
      listener: NAME,
      users: { type: 'object', required: ['monitor', 'canary'], additionalProperties: false, properties: { monitor: NAME, canary: NAME } },
      monitoring_hosts: NAME,                                    // CHLAUTH per-octet address pattern
      monitoring_host: NAME,                                     // where the client exporter and the canary run (default exporter_host)
      exporter_poll_interval: DURATION,
      canary_interval: DURATION,
      log_source: { type: 'string', enum: ['docker', 'amqerr-json'] },
    },
  },
  host: { type: 'object', additionalProperties: false, properties: {} },
  instance: {
    type: 'object',
    required: ['client_port', 'channels', 'credentials'],
    additionalProperties: false,
    properties: {
      native_port: PORT,
      client_port: PORT,
      channels: { type: 'object', required: ['monitoring', 'canary'], additionalProperties: false, properties: { monitoring: NAME, canary: NAME, define: { type: 'boolean' } } },
      tls: nullable({ type: 'object', required: ['ccdt_url', 'key_repository'], additionalProperties: false, properties: { ccdt_url: NAME, key_repository: NAME, cipher: NAME, sslcauth: { type: 'string', enum: ['REQUIRED', 'OPTIONAL'] } } }),
      credentials: { type: 'object', required: ['monitor_secret', 'canary_secret'], additionalProperties: false, properties: { monitor_secret: NAME, canary_secret: NAME } },
      rdqm: { type: 'object', required: ['group'], additionalProperties: false, properties: { group: NAME, dr: { type: 'boolean' } } },
      // floors for the counted kinds of the expected sets: how many monitored queues / channels
      // this queue manager should show (a journey's inventory check breaches below them)
      expect: { type: 'object', additionalProperties: false, properties: { queues: { type: 'integer', minimum: 0 }, channels: { type: 'integer', minimum: 0 } } },
    },
  },
};

// ---------------------------------------------------------------- 2.3 the product's inventory rules
// What used to sit in the generic core: an rdqm-ha queue manager needs three hosts and the
// floating address; a dual-vantage non-container environment needs every queue manager's
// local exporter port; client_port is unique per exporter host across environments (an
// exporter host is a machine two environments may share; without one the port is scoped to
// the environment); native_port is unique per host within an environment.
export function checkInventory({ envs, itemLabel }) {
  const errors = [];
  const clientPortSeen = new Map();
  for (const [env, m] of Object.entries(envs)) {
    const nativePortSeen = new Map();
    for (const qm of m.instances) {
      const label = itemLabel(qm);
      const p = isObj(qm.params) ? qm.params : {};
      if (qm.shape === 'rdqm-ha') {
        if (list(qm.hosts).length < 3) errors.push(`${label}: shape rdqm-ha needs at least 3 hosts, has ${list(qm.hosts).length}`);
        if (!isObj(qm.address)) errors.push(`${label}: shape rdqm-ha needs an address (the floating IP)`);
      }
      if (m.vantage === 'dual' && m.profile === 'non-container' && p.native_port == null) errors.push(`${label}: environment ${env} is vantage dual with profile non-container, so params.native_port is required (the local exporter's port)`);
      if (p.client_port != null) {
        const eh = qm.exporter_host ?? '(no exporter_host)';
        const key = `${qm.exporter_host ? eh : `${env}/${eh}`}:${p.client_port}`;
        if (clientPortSeen.has(key)) errors.push(`${label}: client_port ${p.client_port} on exporter host ${eh} is also used by queue manager ${clientPortSeen.get(key)}`);
        else clientPortSeen.set(key, qm.name);
      }
      if (p.native_port != null) {
        for (const hn of list(qm.hosts)) {
          const key = `${hn}:${p.native_port}`;
          if (nativePortSeen.has(key)) errors.push(`${label}: native_port ${p.native_port} on host ${hn} is also used by queue manager ${nativePortSeen.get(key)}`);
          else nativePortSeen.set(key, qm.name);
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------- the expected sets (site.json)
// The queue managers answer on the exporter job (and the native job in a dual vantage), where
// the target's static qmgr label lands on `up` (design §8). The lab is the exception, on
// purpose (STATUS.md): its exporter target carries no qmgr label, so there only the native job
// answers for QM1 and the exporter's unlabelled `up` drops out of `max by (qmgr)`. No `host`
// kind: no MQ scrape job labels `up` with host. Queues and channels are counted per queue
// manager from the exporter's gauges over the last five minutes — the inventory cannot
// enumerate them — with floors from params.expect where a queue manager declares them.
export function expectedKinds(ctx) {
  const floors = (field) => Object.fromEntries(ctx.instances.filter(q => Number.isInteger(q.params?.expect?.[field])).map(q => [q.name, q.params.expect[field]]));
  const pattern = promqlString(ctx.p.app_queue_pattern || '.*');
  return {
    qmgr: { jobs: ctx.vantage === 'dual' ? ['ibmmq-exporter', 'ibmmq-native'] : ['ibmmq-exporter'] },
    queue: { title: 'queue', label: 'queue', per: 'qmgr', query: `count by (qmgr) (last_over_time(ibmmq_queue_depth{queue=~"${pattern}"}[5m]))`, min: floors('queues') },
    channel: { title: 'channel', label: 'channel', per: 'qmgr', query: 'count by (qmgr) (last_over_time(ibmmq_channel_status_squash[5m]))', min: floors('channels') },
  };
}

// ---------------------------------------------------------------- helpers
const hostPort = (url) => { try { return new URL(url).host; } catch { return String(url).replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, ''); } };
const connName = (qm) => `${qm.address.host}(${qm.address.port})`;

/** The lab `for:` of every reference alert (the alerts template of the Templates stage renders the same literals). */
let forLabCache = null;
export function referenceAlertFor() {
  if (!forLabCache) {
    const groups = parseYaml(readFileSync(resolve(ROOT, REFERENCE_ALERTS), 'utf8')).groups || [];
    forLabCache = Object.fromEntries(groups.flatMap(g => g.rules || []).filter(r => r.alert).map(r => [r.alert, r.for || '0s']));
  }
  return forLabCache;
}

/** One `- targets: [...]` static_configs entry per queue manager (labels are fleet-only: the lab pack keeps its reference line). */
function staticConfigs(ctx, source, target) {
  const indent = ' '.repeat(14), labelIndent = ' '.repeat(16);
  return ctx.qmgrs.map(qm => {
    const line = `- targets: [${target(qm)}]`;
    if (ctx.lab) return line;
    return `${line}\n${labelIndent}labels: { qmgr: ${qm.name}, environment: ${ctx.env}, site: ${ctx.siteOf(qm) ?? qm.site ?? 'unknown'}, shape: ${qm.shape}, source: ${source} }`;
  }).join(`\n${indent}`);
}

// ---------------------------------------------------------------- §6 site-pack derivation
/**
 * Exact-count anchors over packs/ibmmq.pack.yaml (counts re-verified against the current file,
 * tools/test-site.mjs asserts them). A replacement never introduces text a later anchor
 * matches, and no anchor overlaps another in the reference text, so the counts hold both when
 * asserted per step and when asserted on the reference all at once.
 */
export function packSubstitutions(ctx) {
  const t = ctx.timing, { dur, durM, secs } = t, p = ctx.p, e = ctx.endpoints;
  const first = ctx.qmgrs[0];
  // promqlString: the values land inside PromQL double-quoted strings, where a regex backslash
  // must be doubled (promtool: "unknown escape sequence" otherwise); the lab's APP.* is unchanged
  const subs = [
    { name: 'app queue pattern', find: 'queue=~"APP.*"', replace: `queue=~"${promqlString(p.app_queue_pattern)}"`, count: 3 },   // :207 :208 :220
    { name: 'deadq exclusion', find: 'queue!="APP.DLQ"', replace: `queue!="${promqlString(p.deadq)}"`, count: 1 },               // :220
    { name: 'deadq selector', find: 'queue="APP.DLQ"', replace: `queue="${promqlString(p.deadq)}"`, count: 1 },                  // :231
    { name: 'window3', find: '[30s]', replace: `[${dur(t.window3)}]`, count: 6 },                                             // :196 (comment) :207 :208 :220 :231 :264
    // the certification job keeps max(30 s, step); anchored with its job_name so the prod
    // override `prometheus.scrape_interval: 30s` (:139) is not touched
    { name: 'certification scrape_interval', find: '- job_name: certification\n            scrape_interval: 30s', replace: `- job_name: certification\n            scrape_interval: ${dur(Math.max(30, t.step))}`, count: 1 },   // :303-304
    { name: 'pipeline scrape_interval', find: 'scrape_interval: 10s', replace: `scrape_interval: ${dur(t.step)}`, count: 2 },   // :292 :297
    { name: 'native targets', find: '- targets: [mq:9157]', replace: staticConfigs(ctx, 'native', qm => `${qm.address.host}:${qm.params.native_port ?? 9157}`), count: 1 },          // :295
    { name: 'exporter targets', find: '- targets: [mq-exporter:9157]', replace: staticConfigs(ctx, 'exporter', qm => `${qm.exporter_host}:${qm.params.client_port}`), count: 1 },   // :299
    { name: 'certification target', find: '- targets: [alert-sink:9095]', replace: `- targets: [${hostPort(e.alert_sink)}]${ctx.lab ? '' : `\n                labels: { environment: ${ctx.env} }`}`, count: 1 },   // :306
    { name: 'recording interval', find: 'interval: 10s }', replace: `interval: ${dur(t.interval)} }`, count: 11 },             // :366-376
    { name: 'canary target', find: 'target: mq(1414)/APP.CANARY\n        interval: 10s', replace: `target: ${connName(first)}/${p.canary_queue}\n        interval: ${dur(t.probe)}`, count: 1 },   // :754-755
    { name: 'orders target', find: 'target: mq(1414)/APP.ORDERS.REQ', replace: `target: ${connName(first)}/${p.orders_queue ?? 'APP.ORDERS.REQ'}`, count: 1 },   // :765 (item dropped when orders_queue is null)
    { name: 'chaos environment', find: 'environment: lab', replace: `environment: ${ctx.env}`, count: 5 },                     // :704 :716 :726 :738 :748
    { name: 'remote_write endpoint', find: 'endpoint: http://prometheus:9090/api/v1/write', replace: `endpoint: ${e.remote_write}`, count: 1 },   // :332
    { name: 'loki endpoint', find: 'endpoints: [http://loki:3100/otlp]', replace: `endpoints: [${e.loki}]`, count: 1 },        // :336
    { name: 'tempo endpoint', find: 'endpoint: tempo:4317', replace: `endpoint: ${e.tempo}`, count: 1 },                        // :339
    { name: 'alert-sink webhook', find: 'webhook: "http://alert-sink:9095/webhook"', replace: `webhook: "${String(e.alert_sink).replace(/\/$/, '')}/webhook"`, count: 3 },   // :611 :615 :619
  ];
  // The lab collector reads ${ENV} and ${MQ_QMGR_NAME} from its environment (docker-compose.yaml);
  // a fleet partition carries the literal environment and, with one queue manager, its name;
  // with several the resource attribute cannot be a literal and the line goes.
  if (!ctx.lab) {
    subs.push({ name: 'resource deployment.environment', find: 'value: "${ENV}"', replace: `value: "${ctx.env}"`, count: 1 });   // :319
    if (ctx.qmgrs.length === 1) subs.push({ name: 'resource mq.qmgr.name', find: 'value: "${MQ_QMGR_NAME}"', replace: `value: "${first.name}"`, count: 1 });   // :318
    else subs.push({ name: 'resource mq.qmgr.name (removed: several queue managers)', find: /^ *- \{ key: mq\.qmgr\.name, +value: "\$\{MQ_QMGR_NAME\}", action: upsert \}\n/m, replace: '', count: 1 });
  }
  // Chaos expected_mttd rebudget (§5.1): lab + (for_env − for_lab) + (group_wait − 5 s) + 2·(step − 10 s),
  // for_lab = the slowest lab `for:` among the experiment's expected alerts. Skipped when the
  // budget is unchanged, so the lab keeps its spelling ('60s' stays '60s', never '1m').
  const forOf = referenceAlertFor();
  for (const exp of list(ctx.refPack?.spec?.validation?.chaos_experiments)) {
    const fors = list(exp.expected_alerts).map(a => forOf[a]).filter(Boolean);
    if (!fors.length || !exp.expected_mttd) continue;
    const forLab = fors.reduce((a, b) => (secs(b) > secs(a) ? b : a));
    const next = t.rebudgetMttd(exp.expected_mttd, forLab);
    if (next === secs(exp.expected_mttd)) continue;
    subs.push({
      name: `chaos ${exp.id} expected_mttd`,
      find: new RegExp('(- id: ' + esc(exp.id) + '\n(?:.*\n)*? *expected_mttd: )' + esc(exp.expected_mttd) + '\\b'),
      replace: `$1${durM(next)}`,
      count: 1,
    });
  }
  return subs;
}

/** List items dropped from the site pack (dropItem throws when one is missing: every value below exists in the reference pack). */
export function packRemovals(ctx) {
  const out = [];
  if (ctx.p.orders_queue == null) out.push({ key: 'id', value: 'orders-flow' });                       // synthetic S4 (:763)
  if (ctx.vantage === 'single') out.push(
    { key: 'id', value: 'qmgr_process_up' },                          // SLI (:172)
    { key: 'id', value: 'qmgr_process_up_99_9' },                     // SLO (:272)
    { key: 'name', value: 'ibmmq:qmgr_process_up:ratio_5m' },         // its recording rules (:366-367; ref:slis.qmgr_process_up would dangle)
    { key: 'name', value: 'ibmmq:qmgr_process_up:error_ratio_5m' },
    { key: 'binds_to', value: 'slis.qmgr_process_up' },               // dashboards (:494 :528)
    { key: 'binds_to', value: 'slos.qmgr_process_up_99_9' },          // (:502 :536 :554)
    { key: 'slo', value: 'qmgr_process_up_99_9' },                    // policy windows (:568) and forecast (:599)
    { key: 'trigger', value: 'alert:ibmmq-queue-manager-down' },      // remediation (:629): no auto-restart on an exporter-only signal
    { key: 'job_name', value: 'ibmmq-native' },                       // pipelines receiver (:291)
    { key: 'id', value: 'qmgr-down' },                                // chaos (:693)
  );
  return out;
}

export function runbooks() { return RUNBOOK; }

// ---------------------------------------------------------------- templates, dashboards
/** Render a registry map now; a template that returns null does not apply to this environment and is listed in site.json `skipped`. */
function rendered(ctx, entries, render) {
  const out = {};
  for (const [path, fn] of entries) {
    const content = render(fn, path);
    if (content == null) { (ctx.manifest.skipped ??= []).push(path); continue; }
    out[path] = content;
  }
  return out;
}
export function templates(ctx) {
  return rendered(ctx, Object.entries(registry.templates), (fn) => fn(ctx));
}
export function perQmgr(ctx, qm) {
  return rendered(ctx, Object.entries(registry.perQmgr).map(([path, fn]) => [path.replaceAll('<qm>', qm.name), fn]), (fn) => fn(ctx, qm));
}
export function fleet(ctxs) {
  return Object.fromEntries(Object.entries(registry.fleet).map(([path, render]) => [path, render(ctxs)]));
}

export function dashboardOptions(ctx) {
  return {
    environment: ctx.env, vantage: ctx.vantage, profile: ctx.profile, names: ctx.p, repo_url: ctx.repoUrl, step: ctx.timing.step,
    qmgrs: ctx.qmgrs.map(q => q.name),
    monitoring_channels: [...new Set(ctx.qmgrs.map(q => q.params?.channels?.monitoring).filter(Boolean))],
  };
}
export function boards({ pack, repoUrl, site }) {
  return generateDashboards(pack, { repoUrl, site }).boards;
}

// ---------------------------------------------------------------- harness (site.json)
/** The C6 families of harness/checks/conformance.mjs, per vantage and profile (design §7.2: the local exporter's counters are `_count` deltas). */
export function families(ctx) {
  const out = [
    ['ibmmq_qmgr_status', 'ibmmq-exporter'], ['ibmmq_queue_depth', 'ibmmq-exporter'], ['ibmmq_queue_attribute_max_depth', 'ibmmq-exporter'],
    ['ibmmq_queue_oldest_message_age', 'ibmmq-exporter'], ['ibmmq_qmgr_log_write_latency_seconds', 'ibmmq-exporter'],
    ['ibmmq_channel_status_squash', 'ibmmq-exporter'], ['ibmmq_qmgr_connection_count', 'ibmmq-exporter'],
  ];
  if (ctx.vantage === 'dual') out.push([ctx.profile === 'non-container' ? 'ibmmq_qmgr_commit_count' : 'ibmmq_qmgr_commit_total', 'ibmmq-native']);
  out.push(['mq_canary_attempts_total', null], ['mq_canary_roundtrip_duration_seconds_bucket', null]);
  return out;
}

export function harness(ctx) {
  const p = ctx.p, t = ctx.timing;
  const notes = [];
  if (ctx.profile === 'non-container') notes.push(`the sum_over_time(...[2m]) / 120 delta estimator was measured at a 10 s poll only; confirm it at ${t.dur(t.poll)} on the first live run`);
  if (ctx.vantage === 'single') notes.push('vantage single: C2 passes on the exporter job alone, C6 has no native family, IBMMQQueueManagerDown does not exist (Silent/Restarted instead)');
  return {
    vantage: ctx.vantage, profile: ctx.profile, environment: ctx.env,
    step: t.step, poll: t.poll, probe: t.probe,
    families: families(ctx),
    services: ['ibmmq', 'mq-canary', ...(p.orders_queue ? ['orders-producer', 'orders-consumer'] : [])],
    names: {
      app_queue_pattern: p.app_queue_pattern, monitored_queues: p.monitored_queues, deadq: p.deadq,
      canary_queue: p.canary_queue, orders_queue: p.orders_queue ?? null, burst_queue: p.burst_queue ?? null,
      listener: p.listener ?? null, users: p.users,
      svrconns: [...new Set(ctx.qmgrs.flatMap(q => [q.params?.channels?.monitoring, q.params?.channels?.canary]).filter(Boolean))],
    },
    queue_managers: ctx.qmgrs.map(q => ({ name: q.name, shape: q.shape, address: q.address ?? null, exporter_host: q.exporter_host ?? null, native_port: q.params?.native_port ?? null, client_port: q.params?.client_port ?? null, channels: q.params?.channels ?? null, tls: Boolean(q.params?.tls) })),
    notes,
  };
}

// ---------------------------------------------------------------- self-checks (§9.3)
export function checks(ctx, files) {
  const errors = [], warnings = [];
  const byPath = new Map(files.map(f => [f.path, f.content]));

  // pipelines: one static entry per queue manager; fleet entries carry the labels; the native
  // static qmgr label equals the exporter's (and the client exporter file's queueManager, once emitted)
  const jobs = Object.fromEntries(list(ctx.pack?.spec?.pipelines?.receivers).filter(r => r.name === 'prometheus').flatMap(r => list(r.scrape_configs)).map(s => [s.job_name, s]));
  const entries = (job) => list(jobs[job]?.static_configs);
  const qmgrOf = (entry, i) => (ctx.lab ? ctx.qmgrs[i]?.name : entry.labels?.qmgr);
  if (!jobs['ibmmq-exporter']) errors.push('site pack: no ibmmq-exporter scrape job');
  if (ctx.vantage === 'dual' && !jobs['ibmmq-native']) errors.push('site pack: vantage dual but no ibmmq-native scrape job');
  if (ctx.vantage === 'single' && jobs['ibmmq-native']) errors.push('site pack: vantage single but the ibmmq-native scrape job is still there');
  for (const job of ['ibmmq-native', 'ibmmq-exporter'].filter(j => jobs[j])) {
    const es = entries(job);
    if (es.length !== ctx.qmgrs.length) errors.push(`site pack: ${job} has ${es.length} static_configs entries for ${ctx.qmgrs.length} queue managers`);
    es.forEach((entry, i) => {
      const name = qmgrOf(entry, i);
      if (!ctx.qmgrs.some(q => q.name === name)) errors.push(`site pack: ${job} entry ${i} has qmgr label ${JSON.stringify(name ?? null)}, not a queue manager of ${ctx.env}`);
      if (!ctx.lab && entry.labels?.environment !== ctx.env) errors.push(`site pack: ${job} entry ${i} carries environment ${JSON.stringify(entry.labels?.environment ?? null)}, expected ${ctx.env}`);
    });
  }
  if (jobs['ibmmq-native']) entries('ibmmq-native').forEach((entry, i) => {
    const native = qmgrOf(entry, i), exporter = qmgrOf(entries('ibmmq-exporter')[i] ?? {}, i);
    if (native !== exporter) errors.push(`site pack: native static qmgr label ${native} does not equal the exporter's ${exporter} (entry ${i})`);
  });
  for (const qm of ctx.qmgrs) {
    const f = byPath.get(`qmgrs/${qm.name}/mq_prometheus.yaml`);
    if (f === undefined) continue;
    let doc; try { doc = parseYaml(f); } catch (e) { errors.push(`qmgrs/${qm.name}/mq_prometheus.yaml: ${e.message}`); continue; }
    if (doc?.connection?.queueManager !== qm.name) errors.push(`qmgrs/${qm.name}/mq_prometheus.yaml: connection.queueManager is ${JSON.stringify(doc?.connection?.queueManager)}, the static qmgr label is ${qm.name}`);
  }

  // ports: client_port unique per exporter host, native_port unique per host
  const seen = new Map();
  for (const qm of ctx.qmgrs) {
    const p = qm.params || {};
    if (p.client_port != null) { const k = `client ${qm.exporter_host ?? '(no exporter_host)'}:${p.client_port}`; if (seen.has(k)) errors.push(`client_port ${p.client_port} on ${qm.exporter_host}: ${qm.name} collides with ${seen.get(k)}`); else seen.set(k, qm.name); }
    if (p.native_port != null) for (const h of list(qm.hosts)) { const k = `native ${h}:${p.native_port}`; if (seen.has(k)) errors.push(`native_port ${p.native_port} on ${h}: ${qm.name} collides with ${seen.get(k)}`); else seen.set(k, qm.name); }
  }

  // every emitted alert rule: severity / pack / sli labels, the sli a pack SLI, the runbook a file
  const slis = new Set(list(ctx.pack?.spec?.slis).map(s => s.id));
  for (const [path, content] of byPath) {
    if (!/^prometheus\/rules\/.*\.ya?ml$/.test(path)) continue;
    let doc; try { doc = parseYaml(content); } catch (e) { errors.push(`${path}: ${e.message}`); continue; }
    for (const r of list(doc?.groups).flatMap(g => list(g.rules))) {
      if (!r.alert) continue;
      for (const l of ['severity', 'pack', 'sli']) if (!r.labels?.[l]) errors.push(`${path}: alert ${r.alert}: missing label ${l}`);
      if (r.labels?.pack && r.labels.pack !== ctx.pack.metadata.name) errors.push(`${path}: alert ${r.alert}: pack label ${r.labels.pack}`);
      if (r.labels?.sli && !slis.has(r.labels.sli)) errors.push(`${path}: alert ${r.alert}: sli label ${r.labels.sli} is not a site-pack SLI`);
      if (r.annotations?.runbook && !existsSync(resolve(ROOT, r.annotations.runbook))) errors.push(`${path}: alert ${r.alert}: runbook ${r.annotations.runbook} does not exist`);
      if (ctx.vantage === 'single') {
        if (r.alert === 'IBMMQQueueManagerDown') errors.push(`${path}: IBMMQQueueManagerDown emitted for vantage single`);
        if (/job="ibmmq-native"/.test(String(r.expr))) errors.push(`${path}: alert ${r.alert} reads job="ibmmq-native", which vantage single does not scrape`);
      }
    }
  }
  return { errors, warnings };
}
