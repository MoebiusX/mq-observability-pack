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
//   mergeInventories(files, { packChosen, module })                 → { inventory, errors }
//   validateInventory(inventory, pack, { schema, module, strict })  → { errors, warnings }
//   resolveEnvironments(inventory, pack)                            → { envs, errors }
//
// An inventory has hosts and INSTANCES — the things a pack monitors: queue managers, brokers,
// clusters, databases. The module says what an instance is (`module.instances`, instancesOf
// below): under which top-level key the file lists them (`key`, default `instances`; the IBM MQ
// module keeps `queue_managers`), the kind name the site's expected sets and inventory series
// use (`kind`, e.g. `qmgr`), the label the live series carry (`label`), the human title in
// error messages (`title`), and a JSON Schema fragment merged into the Instance definition
// (`schema`: required keys such as `shape`, its enum). The core knows nothing else about them;
// product semantics (ports that must be unique, shapes that need three hosts) live in
// `module.checkInventory`. The merged model and every environment carry `instances` and, when
// the module's key differs, the same array under that key as an alias.
//
// Environment inheritance (design §2.3):
//   host.env     = host.env ?? file.env                                (error when neither)
//   instance.env = instance.env ?? unique(env of its hosts) ?? file.env (error when the hosts
//                                                                        disagree, when it differs
//                                                                        from its hosts' env, or
//                                                                        nothing resolves)
// Names: a host name is unique across the whole merged inventory (a host is a machine; two
// environments may share it); an instance name is unique within one environment (design §2.3),
// so QM1 in prod and QM1 in staging are two instances and the check runs once the environments
// are resolved. Every error names the offending item and the file it came from.

import { parse as parseYaml } from '../mini-yaml.mjs';
import { validate } from '../validator.mjs';

export const INVENTORY_VERSION = 'v1';
export const PARAM_DEFS = { site: 'siteParams', host: 'hostParams', instance: 'instanceParams' };
export const DEFAULT_INSTANCES = Object.freeze({ key: 'instances', kind: 'instance', label: 'instance', title: 'instance' });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const uniq = (arr) => [...new Set(arr)];
const q = (v) => JSON.stringify(v);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
 * The module's instance descriptor with the defaults filled in: { key, kind, label, title,
 * schema }. `key`, `kind` and `label` must be identifiers (they become a YAML key, a metric-name
 * segment and a label name); an invalid descriptor is a module error, thrown here.
 */
export function instancesOf(module = null) {
  const d = isObj(module?.instances) ? module.instances : {};
  const ident = (field, fallback) => {
    if (d[field] === undefined) return fallback;
    if (typeof d[field] !== 'string' || !IDENT.test(d[field])) throw new Error(`module.instances.${field} must be an identifier (got ${q(d[field])})`);
    return d[field];
  };
  const key = ident('key', DEFAULT_INSTANCES.key);
  const kind = ident('kind', DEFAULT_INSTANCES.kind);
  const label = ident('label', kind);
  const title = d.title === undefined ? (kind === DEFAULT_INSTANCES.kind ? DEFAULT_INSTANCES.title : kind) : d.title;
  if (typeof title !== 'string' || !title) throw new Error(`module.instances.title must be a non-empty string (got ${q(d.title)})`);
  if (d.schema !== undefined && !isObj(d.schema)) throw new Error('module.instances.schema must be a JSON Schema object fragment');
  return { key, kind, label, title, schema: isObj(d.schema) ? d.schema : null };
}

/** The descriptor a merged inventory (or an environment model) carries, or the defaults. */
export const instanceKindOf = (inventory) => (isObj(inventory?.instanceKind) ? inventory.instanceKind : { ...DEFAULT_INSTANCES });

/**
 * The inventory schema for a module: the parameter fragments spliced in as $defs/siteParams,
 * $defs/hostParams and $defs/instanceParams (permissive objects without a module or a fragment),
 * the module's instance fragment merged into $defs/Instance (its `required` keys appended, its
 * `properties` merged over the base ones), and the instances collection moved under the
 * module's key. Returns a new object; `base` is not mutated.
 */
export function inventorySchema(base, module = null, { instances = null } = {}) {
  if (!isObj(base)) throw new Error('inventorySchema: the base schema object is required (the CLI reads inventory.schema.json)');
  // The caller may name the collection (a merged inventory knows its key): with a module the
  // module's fragment and titles apply under that key; without one the placeholders stay
  // permissive and the descriptor is the caller's.
  const fromModule = instancesOf(module);
  const keyOf = (d) => (typeof d?.key === 'string' && IDENT.test(d.key) ? d.key : null);
  const inst = !isObj(instances) ? fromModule
    : module ? { ...fromModule, key: keyOf(instances) ?? fromModule.key }
      : { ...fromModule, ...instances, key: keyOf(instances) ?? fromModule.key, schema: null };
  const schema = { ...base, properties: { ...(base.properties || {}) }, $defs: { ...(base.$defs || {}) } };
  const ps = module?.paramsSchema || {};
  for (const [scope, def] of Object.entries(PARAM_DEFS)) {
    if (isObj(ps[scope])) schema.$defs[def] = ps[scope];
    else if (!schema.$defs[def]) schema.$defs[def] = { type: 'object' };
  }
  const baseDef = isObj(schema.$defs.Instance) ? schema.$defs.Instance : { type: 'object', required: ['name'], additionalProperties: false, properties: {} };
  if (inst.schema) {
    schema.$defs.Instance = {
      ...baseDef,
      ...inst.schema,
      required: uniq([...list(baseDef.required), ...list(inst.schema.required)]),
      properties: { ...(baseDef.properties || {}), ...(isObj(inst.schema.properties) ? inst.schema.properties : {}) },
    };
  }
  if (inst.key !== DEFAULT_INSTANCES.key) {
    schema.properties[inst.key] = schema.properties[DEFAULT_INSTANCES.key] || { type: 'array', items: { $ref: '#/$defs/Instance' } };
    delete schema.properties[DEFAULT_INSTANCES.key];
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
  let full;
  try { full = schema ? inventorySchema(schema, module) : null; } catch (e) { return { files, errors: [String(e.message || e)] }; }
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
 * Merge inventory files into one model (design §2.3): hosts and instances are concatenated,
 * `environments` keys are merged (the same key in two files must be deep-equal), a file-level
 * `env` applies only to that file's hosts and instances (kept as `source: { file, env }` on each
 * item, never written into the item's own `env`). The merged model carries `instanceKind` (the
 * module's descriptor), `instances` (plus the same array under the module's key when it
 * differs) and `files: [{ name, env, pack }]`; `pack` is the unique file-level pack reference.
 * Two files naming different packs is an error unless `packChosen` says the caller picked the
 * pack itself (the CLI always does). Host names are unique across files; instance names are
 * checked per environment in resolveEnvironments.
 */
export function mergeInventories(files, { packChosen = false, module = null } = {}) {
  const errors = [];
  const inst = instancesOf(module);
  const inventory = {
    inventory: INVENTORY_VERSION, pack: null, environments: {}, hosts: [], instances: [],
    instanceKind: { key: inst.key, kind: inst.kind, label: inst.label, title: inst.title },
    files: [],
  };
  if (inst.key !== DEFAULT_INSTANCES.key) inventory[inst.key] = inventory.instances;
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
    for (const it of list(doc[inst.key])) {
      if (!isObj(it) || !it.name) { errors.push(`${name}: a ${inst.title} without a name`); continue; }
      inventory.instances.push({ ...it, source: { file: name, env: doc.env ?? null } });
    }
  }
  const up = uniq(packs);
  if (up.length > 1 && !packChosen) errors.push(`the inventories name different packs: ${up.join(', ')} (pass --pack to choose)`);
  inventory.pack = up[0] ?? null;
  return { inventory, errors };
}

const itemLabel = (kind, item) => `${kind} ${item.name}${item.source?.file ? ` (${item.source.file})` : ''}`;

/** Resolved environment of every host and instance; errors name the item. */
function resolveItems(inventory) {
  const errors = [];
  const title = instanceKindOf(inventory).title;
  const hosts = new Map();
  for (const h of list(inventory.hosts)) {
    const env = h.env ?? h.source?.env ?? null;
    if (!env) errors.push(`${itemLabel('host', h)}: no env and its file declares none`);
    hosts.set(h.name, { ...h, env });
  }
  const instances = [];
  for (const it of list(inventory.instances)) {
    const label = itemLabel(title, it);
    const hostEnvs = [];
    for (const hn of list(it.hosts)) {
      const h = hosts.get(hn);
      if (!h) { errors.push(`${label}: host ${hn} is not in hosts[]`); continue; }
      if (h.env) hostEnvs.push({ host: hn, env: h.env });
    }
    const envsOfHosts = uniq(hostEnvs.map(x => x.env));
    let env = null;
    if (envsOfHosts.length > 1) {
      errors.push(`${label}: its hosts disagree on env: ${hostEnvs.map(x => `${x.host}=${x.env}`).join(', ')}`);
    } else if (it.env) {
      env = it.env;
      if (envsOfHosts.length === 1 && envsOfHosts[0] !== env) errors.push(`${label}: env ${env} differs from its hosts' env ${envsOfHosts[0]} (${hostEnvs.map(x => x.host).join(', ')})`);
    } else if (envsOfHosts.length === 1) {
      env = envsOfHosts[0];
    } else if (it.source?.env) {
      env = it.source.env;
    } else {
      errors.push(`${label}: no env, no hosts with an env, and its file declares none`);
    }
    instances.push({ ...it, env });
  }
  return { hosts: [...hosts.values()], instances, errors };
}

/** Every environment name an inventory mentions (file env, host env, instance env, environments keys). */
export function referencedEnvironments(inventory) {
  const names = [];
  for (const f of list(inventory.files)) if (f.env) names.push(f.env);
  for (const h of list(inventory.hosts)) { if (h.env) names.push(h.env); if (h.source?.env) names.push(h.source.env); }
  for (const it of list(inventory.instances)) { if (it.env) names.push(it.env); if (it.source?.env) names.push(it.source.env); }
  names.push(...Object.keys(isObj(inventory.environments) ? inventory.environments : {}));
  return uniq(names);
}

const packEnvironments = (pack) => list(pack?.metadata?.bindings?.environments);

/**
 * Per-environment model: { [env]: EnvModel } where EnvModel = { env, scrape_interval, vantage
 * (default dual), profile (default container), endpoints, receivers, secrets, repo_url,
 * rule_labels, params, hosts[], instances[], instanceKind } with every host and instance
 * carrying its resolved env, `exporter_host` defaulted to the environment's
 * `params.monitoring_host`, and `site` (the site label of its hosts). The instances are also
 * reachable under the module's key when it differs (the same array). Environments that only
 * appear as `environments.<env>` blocks (no member) are not returned; the pack is used for its
 * bindings list only, so the caller gets the same errors as validateInventory for the names.
 */
export function resolveEnvironments(inventory, pack) {
  const { hosts, instances, errors } = resolveItems(inventory);
  const kind = instanceKindOf(inventory);
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
        instances: [],
        instanceKind: { ...kind },
      };
      if (kind.key !== DEFAULT_INSTANCES.key) envs[env][kind.key] = envs[env].instances;
    }
    return envs[env];
  };
  const hostByName = new Map(hosts.map(h => [h.name, h]));
  for (const h of hosts) if (h.env) model(h.env).hosts.push(h);
  const seen = new Map();   // `${env}:${name}` → file: a name is unique within one environment (design §2.3)
  for (const it of instances) {
    if (!it.env) continue;
    const m = model(it.env);
    const key = `${it.env}:${it.name}`;
    const file = it.source?.file ?? null;
    if (seen.has(key)) {
      const prev = seen.get(key);
      errors.push(`${itemLabel(kind.title, it)}: ${prev && prev !== file ? `also declared in ${prev}` : 'declared twice'} in environment ${it.env}`);
    } else seen.set(key, file);
    const sites = uniq(list(it.hosts).map(hn => hostByName.get(hn)?.site).filter(Boolean));
    m.instances.push({
      ...it,
      exporter_host: it.exporter_host ?? m.params?.monitoring_host ?? null,
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
 * into errors. The core checks what every inventory shares — the schema, the environment names,
 * the host references, one address per environment, the module's required params even when a
 * `params` block is omitted; the module's `checkInventory({ inventory, envs, hostByName,
 * itemLabel, instanceKind })` adds the product's own rules and returns error strings.
 */
export function validateInventory(inventory, pack, { schema = null, module = null, strict = false } = {}) {
  const errors = [], warnings = [];
  if (!isObj(inventory)) return { errors: ['inventory: not a mapping'], warnings };
  // The merged inventory's descriptor when it has one (mergeInventories with the module),
  // else the module's: a module-less validation still checks the collection where it is.
  const kind = isObj(inventory.instanceKind) ? inventory.instanceKind : (() => { const d = instancesOf(module); return { key: d.key, kind: d.kind, label: d.label, title: d.title }; })();
  let full;
  try { full = schema ? inventorySchema(schema, module, { instances: kind }) : null; } catch (e) { return { errors: [String(e.message || e)], warnings }; }
  if (full) {
    const strip = ({ source: _source, ...rest }) => rest;
    const doc = { inventory: inventory.inventory, environments: inventory.environments || {}, hosts: list(inventory.hosts).map(strip), [kind.key]: list(inventory.instances).map(strip) };
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
  // environment with members and every host and instance.
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
    list(inventory.instances).forEach((it, i) => defaulted(it, PARAM_DEFS.instance, `$.${kind.key}[${i}].params`));
  }

  // Generic semantics: every referenced host exists; an address is one instance's per environment.
  const label = (it) => itemLabel(kind.title, it);
  for (const [env, m] of Object.entries(envs)) {
    const addressSeen = new Map();
    for (const it of m.instances) {
      if (isObj(it.address) && it.address.host) {
        const key = String(it.address.host);
        if (addressSeen.has(key)) errors.push(`${label(it)}: address.host ${key} is also used by ${kind.title} ${addressSeen.get(key)} in environment ${env}`);
        else addressSeen.set(key, it.name);
      }
      for (const hn of list(it.hosts)) if (!hostByName.has(hn)) { const e = `${label(it)}: host ${hn} is not in hosts[]`; if (!errors.includes(e)) errors.push(e); }
    }
  }
  // The product's own rules (ports, shapes, what a profile requires) belong to the module.
  if (typeof module?.checkInventory === 'function') {
    try {
      const found = module.checkInventory({ inventory, envs, hostByName, itemLabel: label, instanceKind: kind });
      for (const e of list(found)) if (typeof e === 'string' && e) errors.push(e);
    } catch (e) { errors.push(`module.checkInventory: ${e.message || e}`); }
  }
  if (strict) { errors.push(...warnings); warnings.length = 0; }
  return { errors: uniq(errors), warnings: uniq(warnings) };
}
