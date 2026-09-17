// tools/site/templates/lib.mjs — helpers shared by the IBM MQ site templates.
//
// Every template is `(ctx) => string` (or `(ctx, qm) => string`) over the reference file under
// stack/ (design rule R1); these helpers only turn inventory values into the spellings those
// files use. Nothing here reads a file or knows a path.

/** host[:port] of a URL or a bare host:port (`http://alert-sink:9095` → `alert-sink:9095`, `tempo:4317` → `tempo:4317`). */
export function hostPort(url) {
  const s = String(url);
  // `tempo:4317` parses as scheme "tempo" for URL(): only strings with `://` are URLs here
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { try { return new URL(s).host; } catch { /* fall through */ } }
  return s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
}

/** scheme://host[:port] of a URL (`http://prometheus:9090/api/v1/write` → `http://prometheus:9090`). */
export function origin(url) {
  const s = String(url);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { try { return new URL(s).origin; } catch { /* fall through */ } }
  return s.replace(/\/.*$/, '');
}

/** Host without the port (`tempo.prod.internal:4317` → `tempo.prod.internal`). */
export function hostOnly(url) {
  return hostPort(url).replace(/:\d+$/, '');
}

export const isHttps = (url) => /^https:\/\//i.test(String(url));

/** MQ CONNAME spelling of a queue manager's client address: `host(port)`. */
export const connName = (qm) => `${qm.address.host}(${qm.address.port})`;

/** The client exporter's scrape target (`exporter_host:client_port`) and the native one (`address.host:native_port`). */
export const exporterTarget = (qm) => `${qm.exporter_host}:${qm.params.client_port}`;
export const nativeTarget = (qm) => `${qm.address.host}:${qm.params.native_port ?? 9157}`;

/** The site label of a queue manager (its hosts' site, else `unknown`). */
export const siteOf = (ctx, qm) => ctx.siteOf(qm) ?? qm.site ?? 'unknown';

/** The target labels every scrape entry carries (design §7.1): { qmgr, environment, site, shape, source }. */
export function targetLabels(ctx, qm, source) {
  return { qmgr: qm.name, environment: ctx.env, site: siteOf(ctx, qm), shape: qm.shape, source };
}

/** `{ k: v, k: v }` flow-mapping spelling of a label object (values bare, as the reference files write them). */
export const flow = (obj) => `{ ${Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(', ')} }`;

/** The rule labels of an alert as the reference files spell them, plus `environment` when the environment asks for rule labels (design §7.3). */
export function ruleLabels(ctx, severity, sli) {
  const l = { severity, pack: ctx.pack.metadata.name, sli };
  if (ctx.ruleLabels) l.environment = ctx.env;
  return flow(l);
}

/** A YAML double-quoted scalar. */
export const q = (s) => JSON.stringify(String(s));

/**
 * A value inside a PromQL double-quoted string literal (`queue=~"…"`): PromQL processes escape
 * sequences there, so a regex such as `ORD\..*` must be written `ORD\\..*` or promtool rejects it
 * ("unknown escape sequence"). Backslashes and double quotes are escaped; nothing else changes,
 * so the lab's `APP.*` renders as itself.
 */
export const promqlString = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** The receiver name of a channel ref: `webhook://alert-sink` → alert-sink, `pagerduty://mq` → pagerduty-mq, `#mq-oncall` → mq-oncall. */
export function receiverName(ref) {
  const s = String(ref);
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(s);
  let name;
  if (m) name = m[1].toLowerCase() === 'webhook' ? m[2] : `${m[1].toLowerCase()}-${m[2]}`;
  else name = s.replace(/^#/, '');
  name = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name) throw new Error(`receiver ${JSON.stringify(ref)}: cannot derive a receiver name`);
  return name;
}

/**
 * The Alertmanager receiver block (indented under `receivers:`) of one channel ref. Secrets are
 * file references from the environment's `secrets` map (design R5): a PagerDuty routing key or
 * a Teams webhook URL is never written here. `webhook://alert-sink` is the environment's
 * alert-sink endpoint (+ /webhook); any other `webhook://host[:port][/path]` is that URL over
 * http unless a secret file is declared for it.
 */
export function receiverBlock(ctx, ref, name = receiverName(ref)) {
  const s = String(ref);
  const secret = ctx.secrets?.[s];
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(s);
  const lines = [`  - name: ${name}`];
  if (m && m[1].toLowerCase() === 'webhook') {
    lines.push('    webhook_configs:');
    if (secret) lines.push(`      - url_file: ${secret}`);
    else if (m[2] === 'alert-sink' || m[2] === hostPort(ctx.endpoints.alert_sink)) lines.push(`      - url: ${String(ctx.endpoints.alert_sink).replace(/\/$/, '')}/webhook`);
    else lines.push(`      - url: http://${m[2]}`);
    lines.push('        send_resolved: true');
  } else if (m && m[1].toLowerCase() === 'pagerduty') {
    if (!secret) throw new Error(`receiver ${s}: no secret file in environments.${ctx.env}.secrets (the PagerDuty routing key is a file reference)`);
    lines.push('    pagerduty_configs:', `      - routing_key_file: ${secret}`, '        send_resolved: true');
  } else if (s.startsWith('#')) {
    if (!secret) throw new Error(`receiver ${s}: no secret file in environments.${ctx.env}.secrets (the Teams webhook URL is a file reference)`);
    lines.push('    msteamsv2_configs:', `      - webhook_url_file: ${secret}`, '        send_resolved: true');
  } else {
    throw new Error(`receiver ${s}: unknown channel form (pagerduty://<service>, #<channel>, webhook://<host>)`);
  }
  return lines.join('\n');
}

/** Per-severity receivers of an environment, deduplicated by name, in sev1..sev3 order: [{ sev, ref, name }]. */
export function receiversOf(ctx) {
  const out = [];
  for (const sev of ['sev1', 'sev2', 'sev3']) {
    const ref = ctx.receivers?.[sev];
    if (ref == null) throw new Error(`environments.${ctx.env}.receivers.${sev} is missing`);
    out.push({ sev: sev.toUpperCase(), ref, name: receiverName(ref) });
  }
  return out;
}

/** The mq_prometheus objects.queues list: the monitored patterns, the DEADQ when no pattern already covers it, then the SYSTEM/AMQ exclusions. */
export function exporterQueues(p) {
  const patterns = [...(p.monitored_queues || [])];
  const covers = (pattern, name) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name);
  if (p.deadq && !patterns.some(x => covers(x, p.deadq))) patterns.push(p.deadq);
  // mq_prometheus applies `!` exclusions to the whole discovered list, an exact name included:
  // "!SYSTEM.*" would hide SYSTEM.DEAD.LETTER.QUEUE from the dlq_depth SLI, so the exclusion is
  // only written when the DEADQ is outside SYSTEM.*.
  if (!(p.deadq && p.deadq.startsWith('SYSTEM.'))) patterns.push('!SYSTEM.*');
  patterns.push('!AMQ.*');
  return patterns;
}

/** The mq_prometheus objects.channels list: one family pattern per SVRCONN of the queue manager (first component wildcarded) + SYSTEM.DEF.*. */
export function exporterChannels(qm) {
  const ch = qm.params?.channels || {};
  const fams = [...new Set([ch.monitoring, ch.canary].filter(Boolean).map(c => `${String(c).split('.')[0]}.*`))];
  return [...fams, 'SYSTEM.DEF.*'];
}

/** YAML list-item spelling of an MQ object pattern: quoted when it starts with `!` or with SYSTEM (as the reference file writes them). */
export const objectItem = (s) => (s.startsWith('!') || s.startsWith('SYSTEM.') ? q(s) : s);

/** "a minute" / "3 minutes" / "90 s" for a number of seconds (alert text). */
export function humanSeconds(sec) {
  if (sec === 60) return 'a minute';
  if (sec % 60 === 0) return `${sec / 60} minutes`;
  return `${sec} s`;
}
