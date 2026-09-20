// tools/site/adapters/example.mjs — a registry adapter for gen-site (design §2.3).
//
//   node tools/gen-site.mjs --registry tools/site/adapters/example.registry.json \
//        --adapter tools/site/adapters/example.mjs --env all --check
//
// toInventory(raw) turns a flat registry, one row per (host, queue manager), into inventory v1;
// the result goes through the same schema and semantic checks as an inventory file, so the
// inventory schema never changes for a registry, only the adapter does. This is the pattern the
// mq-ops adapter next to the 50974-mq-registry copies: map its columns in rowToQmgr() and
// rowToHost(), keep the environment wiring in ENVIRONMENTS (a registry row has no endpoints).
//
// Row (all strings unless noted; `host` and `qmgr` and `env` are required):
//   host           DNS name of the machine; a queue manager spread over several hosts (rdqm-ha,
//                  rdqm-dr, multi-instance) is one row per host, same qmgr and env
//   qmgr, env      queue manager name; environment (must be in metadata.bindings.environments)
//   shape          container | host | multi-instance | rdqm-ha | rdqm-dr (default host)
//   site           free label of the host (dc1, dc2, …)
//   ip, port       what clients connect to (the floating IP for RDQM); ip defaults to the host, port to 1414
//   ccdt           CCDT URL (file:///… or https://…) when the channels are TLS; absent = no TLS
//   key_repository, cipher, sslcauth   TLS details next to the CCDT
//   native_port, client_port (integers)   the local exporter's port (dual vantage) and the client exporter's port
//   monitor_channel, canary_channel       SVRCONN names (default MON.SVRCONN / CANARY.SVRCONN)
//   define_channels (boolean)             whether the MQSC template defines them (default true)
//   monitor_secret, canary_secret         secret references (paths); default /run/secrets/mqmon-<qmgr>, mqcanary-<qmgr>
//   rdqm_group, rdqm_dr (boolean)         the RDQM group and whether the row is the DR side
//   exporter_host                         where the client exporter and canary run (default: the environment's monitoring_host)
//
// raw may also be `{ environments, rows }` (or `records` / `queue_managers` for the list) to
// carry the environment wiring in the registry itself; those blocks override ENVIRONMENTS.

const list = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const int = (v) => (v == null || v === '' ? undefined : Number(v));
const bool = (v, d) => (v == null ? d : v === true || v === 'true' || v === 1 || v === '1');

/** Per-environment wiring the registry does not carry (endpoints, receivers, secrets, site params). */
export const ENVIRONMENTS = {
  prod: {
    scrape_interval: '30s', vantage: 'dual', profile: 'non-container',
    endpoints: { remote_write: 'https://mimir.prod.internal/api/v1/push', loki: 'https://loki.prod.internal/otlp', tempo: 'tempo.prod.internal:4317', alertmanager: 'https://am.prod.internal', alert_sink: 'http://alert-sink.mq-obs.svc:9095', otlp: 'http://otel-gateway.mq-obs.svc:4318', grafana: 'https://grafana.prod.internal' },
    receivers: { sev1: 'pagerduty://mq', sev2: '#mq-oncall', sev3: '#mq-team' },
    secrets: { 'pagerduty://mq': '/etc/alertmanager/secrets/pagerduty_mq', '#mq-oncall': '/etc/alertmanager/secrets/msteams_mq_oncall', '#mq-team': '/etc/alertmanager/secrets/msteams_mq_team' },
    repo_url: 'https://github.com/MoebiusX/mq-observability-pack/blob/main',
    params: { app_queue_pattern: 'ORD\\..*|PAY\\..*', monitored_queues: ['ORD.*', 'PAY.*'], deadq: 'SYSTEM.DEAD.LETTER.QUEUE', canary_queue: 'MON.CANARY', orders_queue: null, listener: 'SYSTEM.LISTENER.TCP.1', users: { monitor: 'mqmon', canary: 'mqcanary' }, monitoring_hosts: '10.20.1-40.*', monitoring_host: 'mon1.prod.internal', exporter_poll_interval: '30s', canary_interval: '30s', log_source: 'amqerr-json' },
  },
  staging: {
    vantage: 'single', profile: 'non-container',
    endpoints: { remote_write: 'https://mimir.stg.internal/api/v1/push', loki: 'https://loki.stg.internal/otlp', tempo: 'tempo.stg.internal:4317', alertmanager: 'https://am.stg.internal', alert_sink: 'http://alert-sink.mq-obs-stg.svc:9095', otlp: 'http://otel-gateway.mq-obs-stg.svc:4318' },
    receivers: { sev1: '#mq-team', sev2: '#mq-team', sev3: '#mq-team' },
    secrets: { '#mq-team': '/etc/alertmanager/secrets/msteams_mq_team' },
    params: { app_queue_pattern: 'ORD\\..*', monitored_queues: ['ORD.*'], deadq: 'SYSTEM.DEAD.LETTER.QUEUE', canary_queue: 'MON.CANARY', orders_queue: null, users: { monitor: 'mqmon', canary: 'mqcanary' }, monitoring_hosts: '10.30.*', monitoring_host: 'mon1.stg.internal', log_source: 'amqerr-json' },
  },
};

const rowsOf = (raw) => (Array.isArray(raw) ? raw : list(raw?.rows ?? raw?.records ?? raw?.queue_managers));

/** One host entry from a row (the first row naming a host wins; later rows must agree on env). */
function rowToHost(row) {
  const h = { name: String(row.host), env: String(row.env) };
  if (row.site) h.site = String(row.site);
  h.roles = [row.shape ? String(row.shape) : 'host'];
  return h;
}

/** One queue manager from its rows (several for a multi-host shape). */
function rowsToQmgr(rows) {
  const r = rows[0];
  const shape = r.shape ? String(r.shape) : 'host';
  const qm = { name: String(r.qmgr), env: String(r.env), shape, hosts: [...new Set(rows.map(x => String(x.host)))] };
  qm.address = { host: String(r.ip ?? r.host), port: int(r.port) ?? 1414 };
  if (r.exporter_host) qm.exporter_host = String(r.exporter_host);
  const params = {
    client_port: int(r.client_port),
    channels: { monitoring: String(r.monitor_channel ?? 'MON.SVRCONN'), canary: String(r.canary_channel ?? 'CANARY.SVRCONN'), define: bool(r.define_channels, true) },
    tls: r.ccdt ? { ccdt_url: String(r.ccdt), key_repository: String(r.key_repository ?? '/etc/mq/tls/mqmon'), ...(r.cipher ? { cipher: String(r.cipher) } : {}), ...(r.sslcauth ? { sslcauth: String(r.sslcauth) } : {}) } : null,
    credentials: { monitor_secret: String(r.monitor_secret ?? `/run/secrets/mqmon-${r.qmgr}`), canary_secret: String(r.canary_secret ?? `/run/secrets/mqcanary-${r.qmgr}`) },
  };
  if (int(r.native_port) != null) params.native_port = int(r.native_port);
  if (/^rdqm-/.test(shape)) params.rdqm = { group: String(r.rdqm_group ?? r.qmgr).toLowerCase(), dr: bool(r.rdqm_dr, shape === 'rdqm-dr') };
  qm.params = params;
  return qm;
}

export function toInventory(raw) {
  const rows = rowsOf(raw);
  if (!rows.length) throw new Error('registry: no rows (expected a JSON list of { host, qmgr, env, … } or { environments, rows })');
  const hosts = new Map();
  const groups = new Map();
  rows.forEach((row, i) => {
    if (!isObj(row)) throw new Error(`registry row ${i}: not an object`);
    for (const k of ['host', 'qmgr', 'env']) if (row[k] == null || row[k] === '') throw new Error(`registry row ${i}: missing ${k}`);
    const h = rowToHost(row);
    const prev = hosts.get(h.name);
    if (prev && prev.env !== h.env) throw new Error(`registry: host ${h.name} is in environment ${prev.env} and ${h.env}`);
    if (!prev) hosts.set(h.name, h);
    const key = `${row.env}/${row.qmgr}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  const envNames = [...new Set(rows.map(r => String(r.env)))];
  const environments = {};
  for (const e of envNames) {
    const block = isObj(raw?.environments?.[e]) ? raw.environments[e] : ENVIRONMENTS[e];
    if (!block) throw new Error(`registry: no environment wiring for ${e} (add it to ENVIRONMENTS in the adapter or to raw.environments)`);
    environments[e] = block;
  }
  return {
    inventory: 'v1',
    environments,
    hosts: [...hosts.values()],
    queue_managers: [...groups.values()].map(rowsToQmgr),
  };
}
