// tools/lib/site/inventory.mjs
//
// Site inventory v1 (gen-site): load, merge, resolve environments, validate. Pure ESM over
// strings and objects — the CLI (tools/gen-site.mjs) reads the files and the schema, this
// module never touches the filesystem, so the same file runs in the browser and in a
// downstream vendored copy (vendor/observogram/lib/site/). Siblings are imported by relative
// path only.
//
// Pipeline:
//   loadInventories(inputs, { schema, module, adapter, registry })  → { files, errors }
//   mergeInventories(files, { packChosen })                         → { inventory, errors }
//   validateInventory(inventory, pack, { schema, module, strict })  → { errors, warnings }
//   resolveEnvironments(inventory, pack)                            → { envs, errors }
//
// Environment inheritance (design §2.3):
//   host.env = host.env ?? file.env                              (error when neither)
//   qm.env   = qm.env ?? unique(env of qm.hosts) ?? file.env     (error when the hosts disagree,
//                                                                 when qm.env differs from its
//                                                                 hosts' env, or nothing resolves)
// Names: a host name is unique across the whole merged inventory (a host is a machine; two
// environments may share it, which is what the client_port check relies on); a queue-manager
// name is unique within one environment (design §2.3), so QM1 in prod and QM1 in staging are
// two queue managers and the check runs once the environments are resolved.
// Every error names the offending item and the file it came from.

import { parse as parseYaml } from '../mini-yaml.mjs';
import { validate } from '../validator.mjs';

export const INVENTORY_VERSION = 'v1';
export const PARAM_DEFS = { site: 'siteParams', host: 'hostParams', instance: 'instanceParams' };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const uniq = (arr) => [...new Set(arr)];
const q = (v) => JSON.stringify(v);

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (typeof a === 'object') {
    if (Array.isArray(b)) return false;
    const ak = Object.keys(a), bk = Object.keys(b);
    return ak.length === bk.length && ak.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * The inventory schema with the module's parameter schemas spliced in as $defs/siteParams,
 * $defs/hostParams and $defs/instanceParams. Without a module (or without a fragment) the
 * placeholders stay permissive objects. Returns a new object; `base` is not mutated.
 */
export function inventorySchema(base, module = null) {
  if (!isObj(base)) throw new Error('inventorySchema: the base schema object is required (the CLI reads inventory.schema.json)');
  const schema = { ...base, $defs: { ...(base.$defs || {}) } };
  const ps = module?.paramsSchema || {};
  for (const [scope, def] of Object.entries(PARAM_DEFS)) {
    if (isObj(ps[scope])) schema.$defs[def] = ps[scope];
    else if (!schema.$defs[def]) schema.$defs[def] = { type: 'object' };
  }
  return schema;
}

/** Schema errors of one inventory document, each prefixed with the file name. */
export function schemaErrors(doc, schema, name = 'inventory') {
  const errors = [];
  validate(doc, schema, '$', errors, schema);
  return errors.map(e => `${name}: ${e}`);
}

function parseInput(input, i) {
  if (typeof input === 'string') return { name: `inventory[${i}]`, text: input };
  if (isObj(input) && ('text' in input || 'doc' in input)) return { name: input.name || `inventory[${i}]`, text: input.text, doc: input.doc };
  if (isObj(input)) return { name: `inventory[${i}]`, doc: input };
  throw new Error(`inventory[${i}]: expected YAML text or an object, got ${typeof input}`);
}

function parseRegistry(registry) {
  if (typeof registry !== 'string') return registry;
  const t = registry.trim();
  if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t);
  return parseYaml(registry);
}

/**
 * Parse every inventory input (YAML text, a parsed object, or { name, text | doc }), append the
 * adapter's view of a registry (`adapter.toInventory(raw)`, raw = the registry as text or
 * object) as one more file, and schema-check each document with the module's parameter
 * schemas. Returns { files: [{ name, doc }], errors }; a file with errors is still returned so
 * later stages can keep reporting, but callers must stop on errors.
 */
export function loadInventories(inputs, { schema, module = null, adapter = null, registry = undefined } = {}) {
  const files = [], errors = [];
  const full = schema ? inventorySchema(schema, module) : null;
  list(inputs).forEach((input, i) => {
    let f;
    try { f = parseInput(input, i); } catch (e) { errors.push(String(e.message || e)); return; }
    if (f.doc === undefined) {
      try { f.doc = parseYaml(f.text); } catch (e) { errors.push(`${f.name}: cannot parse: ${e.message || e}`); return; }
    }
    files.push({ name: f.name, doc: f.doc });
  });
  if (registry !== undefined || adapter) {
    if (!adapter || typeof adapter.toInventory !== 'function') errors.push('registry: an adapter exporting toInventory(raw) is required');
    else if (registry === undefined) errors.push('adapter: a registry is required');
    else {
      try {
        const raw = parseRegistry(registry);
        const doc = adapter.toInventory(raw);
        if (!isObj(doc)) errors.push('adapter: toInventory(raw) must return an inventory object');
        else files.push({ name: 'registry (adapter)', doc });
      } catch (e) { errors.push(`adapter: ${e.message || e}`); }
    }
  }
  for (const f of files) {
    if (!isObj(f.doc)) { errors.push(`${f.name}: not a mapping`); continue; }
    if (f.doc.inventory !== INVENTORY_VERSION) errors.push(`${f.name}: inventory: ${q(f.doc.inventory)} is not ${q(INVENTORY_VERSION)}`);
    if (full) errors.push(...schemaErrors(f.doc, full, f.name));
  }
  return { files, errors };
}

/**
 * Merge inventory files into one model (design §2.3): hosts and queue managers are
 * concatenated, `environments` keys are merged (the same key in two files must be deep-equal),
 * a file-level `env` applies only to that file's hosts and queue managers (kept as
 * `source: { file, env }` on each item, never written into the item's own `env`). The merged
 * model carries `files: [{ name, env, pack }]`; `pack` is the unique file-level pack reference.
 * Two files naming different packs is an error unless `packChosen` says the caller picked the
 * pack itself (the CLI always does: `--pack`, or each file's `pack:` resolved relative to that
 * file, which two files in different directories cannot spell identically). Host names are
 * unique across files; queue-manager names are checked per environment in resolveEnvironments.
 */
export function mergeInventories(files, { packChosen = false } = {}) {
  const errors = [];
  const inventory = { inventory: INVENTORY_VERSION, pack: null, environments: {}, hosts: [], queue_managers: [], files: [] };
  const envOwner = {};
  const seenHost = new Map();
  const packs = [];
  for (const f of list(files)) {
    const name = f.name || 'inventory';
    const doc = f.doc;
    if (!isObj(doc)) { errors.push(`${name}: not a mapping`); continue; }
    inventory.files.push({ name, env: doc.env ?? null, pack: doc.pack ?? null });
    if (doc.pack) packs.push(doc.pack);
    for (const [env, block] of Object.entries(isObj(doc.environments) ? doc.environments : {})) {
      if (env in inventory.environments) {
        if (!deepEqual(inventory.environments[env], block)) errors.push(`${name}: environments.${env} is also declared in ${envOwner[env]} with different content`);
        continue;
      }
      inventory.environments[env] = block;
      envOwner[env] = name;
    }
    for (const h of list(doc.hosts)) {
      if (!isObj(h) || !h.name) { errors.push(`${name}: a host without a name`); continue; }
      const prev = seenHost.get(h.name);
      if (prev) errors.push(`${name}: host ${h.name} is also declared in ${prev}`);
      else seenHost.set(h.name, name);
      inventory.hosts.push({ ...h, source: { file: name, env: doc.env ?? null } });
    }
    for (const qm of list(doc.queue_managers)) {
      if (!isObj(qm) || !qm.name) { errors.push(`${name}: a queue manager without a name`); continue; }
      inventory.queue_managers.push({ ...qm, source: { file: name, env: doc.env ?? null } });
    }
  }
  const up = uniq(packs);
  if (up.length > 1 && !packChosen) errors.push(`the inventories name different packs: ${up.join(', ')} (pass --pack to choose)`);
  inventory.pack = up[0] ?? null;
  return { inventory, errors };
}

const itemLabel = (kind, item) => `${kind} ${item.name}${item.source?.file ? ` (${item.source.file})` : ''}`;

/** Resolved environment of every host and queue manager; errors name the item. */
function resolveItems(inventory) {
  const errors = [];
  const hosts = new Map();
  for (const h of list(inventory.hosts)) {
    const env = h.env ?? h.source?.env ?? null;
    if (!env) errors.push(`${itemLabel('host', h)}: no env and its file declares none`);
    hosts.set(h.name, { ...h, env });
  }
  const qms = [];
  for (const qm of list(inventory.queue_managers)) {
    const label = itemLabel('queue manager', qm);
    const hostEnvs = [];
    for (const hn of list(qm.hosts)) {
      const h = hosts.get(hn);
      if (!h) { errors.push(`${label}: host ${hn} is not in hosts[]`); continue; }
      if (h.env) hostEnvs.push({ host: hn, env: h.env });
    }
    const envsOfHosts = uniq(hostEnvs.map(x => x.env));
    let env = null;
    if (envsOfHosts.length > 1) {
      errors.push(`${label}: its hosts disagree on env: ${hostEnvs.map(x => `${x.host}=${x.env}`).join(', ')}`);
    } else if (qm.env) {
      env = qm.env;
      if (envsOfHosts.length === 1 && envsOfHosts[0] !== env) errors.push(`${label}: env ${env} differs from its hosts' env ${envsOfHosts[0]} (${hostEnvs.map(x => x.host).join(', ')})`);
    } else if (envsOfHosts.length === 1) {
      env = envsOfHosts[0];
    } else if (qm.source?.env) {
      env = qm.source.env;
    } else {
      errors.push(`${label}: no env, no hosts with an env, and its file declares none`);
    }
    qms.push({ ...qm, env });
  }
  return { hosts: [...hosts.values()], qms, errors };
}

/** Every environment name an inventory mentions (file env, host env, qm env, environments keys). */
export function referencedEnvironments(inventory) {
  const names = [];
  for (const f of list(inventory.files)) if (f.env) names.push(f.env);
  for (const h of list(inventory.hosts)) { if (h.env) names.push(h.env); if (h.source?.env) names.push(h.source.env); }
  for (const qm of list(inventory.queue_managers)) { if (qm.env) names.push(qm.env); if (qm.source?.env) names.push(qm.source.env); }
  names.push(...Object.keys(isObj(inventory.environments) ? inventory.environments : {}));
  return uniq(names);
}

const packEnvironments = (pack) => list(pack?.metadata?.bindings?.environments);

/**
 * Per-environment model: { [env]: EnvModel } where EnvModel = { env, scrape_interval, vantage
 * (default dual), profile (default container), endpoints, receivers, secrets, repo_url,
 * rule_labels, params, hosts[], queue_managers[] } with every host and queue manager carrying its
 * resolved env, `exporter_host` defaulted to the environment's `params.monitoring_host`, and
 * `site` (the site label of its hosts). Environments that only appear as `environments.<env>`
 * blocks (no member) are not returned; the pack is used for its bindings list only, so the
 * caller gets the same errors as validateInventory for the environment names.
 */
export function resolveEnvironments(inventory, pack) {
  const { hosts, qms, errors } = resolveItems(inventory);
  const allowed = packEnvironments(pack);
  const blocks = isObj(inventory.environments) ? inventory.environments : {};
  const envs = {};
  const model = (env) => {
    if (!envs[env]) {
      const b = blocks[env] || {};
      envs[env] = {
        env,
        declared: env in blocks,
        scrape_interval: b.scrape_interval ?? null,
        vantage: b.vantage ?? 'dual',
        profile: b.profile ?? 'container',
        endpoints: b.endpoints ?? {},
        receivers: b.receivers ?? {},
        secrets: b.secrets ?? {},
        repo_url: b.repo_url ?? null,
        rule_labels: b.rule_labels ?? false,
        params: b.params ?? {},
        hosts: [],
        queue_managers: [],
      };
    }
    return envs[env];
  };
  const hostByName = new Map(hosts.map(h => [h.name, h]));
  for (const h of hosts) if (h.env) model(h.env).hosts.push(h);
  const seenQm = new Map();   // `${env}:${name}` → file: a name is unique within one environment (design §2.3)
  for (const qm of qms) {
    if (!qm.env) continue;
    const m = model(qm.env);
    const key = `${qm.env}:${qm.name}`;
    const file = qm.source?.file ?? null;
    if (seenQm.has(key)) {
      const prev = seenQm.get(key);
      errors.push(`${itemLabel('queue manager', qm)}: ${prev && prev !== file ? `also declared in ${prev}` : 'declared twice'} in environment ${qm.env}`);
    } else seenQm.set(key, file);
    const sites = uniq(list(qm.hosts).map(hn => hostByName.get(hn)?.site).filter(Boolean));
    m.queue_managers.push({
      ...qm,
      exporter_host: qm.exporter_host ?? m.params?.monitoring_host ?? null,
      site: sites.length === 1 ? sites[0] : (sites[0] ?? null),
    });
  }
  for (const env of Object.keys(envs)) {
    if (allowed.length && !allowed.includes(env)) errors.push(`environment ${env}: not in the pack's metadata.bindings.environments [${allowed.join(', ')}]`);
    // every environment with members needs the block: a host-only environment is selected and rendered too
    if (!envs[env].declared) errors.push(`environment ${env}: no environments.${env} block in the inventory (endpoints are required to emit anything)`);
  }
  return { envs, errors };
}

/**
 * Schema + semantic validation of a merged inventory against a pack (design §2.3). Returns
 * { errors, warnings }. `strict` turns the warnings (a pack without spec.environments.<env>)
 * into errors. The schema check runs per original file when the merged model carries them,
 * otherwise on the (single) document itself.
 */
export function validateInventory(inventory, pack, { schema = null, module = null, strict = false } = {}) {
  const errors = [], warnings = [];
  if (!isObj(inventory)) return { errors: ['inventory: not a mapping'], warnings };
  const full = schema ? inventorySchema(schema, module) : null;
  if (full) {
    const strip = ({ source: _source, ...rest }) => rest;
    const doc = { inventory: inventory.inventory, environments: inventory.environments || {}, hosts: list(inventory.hosts).map(strip), queue_managers: list(inventory.queue_managers).map(strip) };
    errors.push(...schemaErrors(doc, full, 'inventory'));
  }
  const allowed = packEnvironments(pack);
  if (!allowed.length) errors.push('pack: metadata.bindings.environments is empty');
  const quoted = `[${allowed.join(', ')}]`;
  const refs = referencedEnvironments(inventory);
  for (const env of refs) if (allowed.length && !allowed.includes(env)) errors.push(`environment ${env}: not in the pack's metadata.bindings.environments ${quoted}`);
  for (const env of refs) if (allowed.includes(env) && !isObj(pack?.spec?.environments?.[env])) warnings.push(`environment ${env}: the pack has no spec.environments.${env} (no overrides apply)`);

  const { envs, errors: resolveErrors } = resolveEnvironments(inventory, pack);
  for (const e of resolveErrors) if (!errors.includes(e)) errors.push(e);
  const hostByName = new Map(list(inventory.hosts).map(h => [h.name, h]));

  // An absent `params` key is the empty block: resolveEnvironments defaults it to {} and the
  // module renders from it, so the module's `required` site/host/instance params must fire
  // whether the block is omitted or written as `{}`. The schema pass above only sees keys that
  // exist; this validates the default in its place, under the same path, for every
  // environment with members and every host and queue manager.
  if (full) {
    const blocks = isObj(inventory.environments) ? inventory.environments : {};
    const defaulted = (owner, def, path) => {
      if (!isObj(owner) || owner.params !== undefined) return;
      const found = [];
      validate({}, { $ref: `#/$defs/${def}` }, path, found, full);
      errors.push(...found.map(e => `inventory: ${e}`));
    };
    for (const env of Object.keys(envs)) if (isObj(blocks[env])) defaulted(blocks[env], PARAM_DEFS.site, `$.environments.${env}.params`);
    list(inventory.hosts).forEach((h, i) => defaulted(h, PARAM_DEFS.host, `$.hosts[${i}].params`));
    list(inventory.queue_managers).forEach((qm, i) => defaulted(qm, PARAM_DEFS.instance, `$.queue_managers[${i}].params`));
  }

  // client_port is unique per exporter host across environments: the exporter host is a machine
  // two environments may share (design §2.3). Without an exporter host the port is scoped to the
  // environment, the only thing known about where that exporter runs.
  const clientPortSeen = new Map();
  for (const [env, m] of Object.entries(envs)) {
    const addressSeen = new Map();
    const nativePortSeen = new Map();
    for (const qm of m.queue_managers) {
      const label = itemLabel('queue manager', qm);
      const p = isObj(qm.params) ? qm.params : {};
      if (qm.shape === 'rdqm-ha') {
        if (list(qm.hosts).length < 3) errors.push(`${label}: shape rdqm-ha needs at least 3 hosts, has ${list(qm.hosts).length}`);
        if (!isObj(qm.address)) errors.push(`${label}: shape rdqm-ha needs an address (the floating IP)`);
      }
      if (m.vantage === 'dual' && m.profile === 'non-container' && p.native_port == null) errors.push(`${label}: environment ${env} is vantage dual with profile non-container, so params.native_port is required (the local exporter's port)`);
      if (isObj(qm.address) && qm.address.host) {
        const key = String(qm.address.host);
        if (addressSeen.has(key)) errors.push(`${label}: address.host ${key} is also used by queue manager ${addressSeen.get(key)} in environment ${env}`);
        else addressSeen.set(key, qm.name);
      }
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
      for (const hn of list(qm.hosts)) if (!hostByName.has(hn)) { const e = `${label}: host ${hn} is not in hosts[]`; if (!errors.includes(e)) errors.push(e); }
    }
  }
  if (strict) { errors.push(...warnings); warnings.length = 0; }
  return { errors: uniq(errors), warnings: uniq(warnings) };
}
