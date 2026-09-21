// tools/lib/site/expected.mjs
//
// The EXPECTED sets of a rendered site: what the inventory says should be reporting, per kind,
// published in site.json (`expected`) and, as recording rules, in the site's inventory rules
// file — so a journey (Observogram's monitor of the monitors) and the site's own alerts can ask
// "is the right number of things being monitored?" against a declared answer instead of a
// guess. Pure and browser-safe (no filesystem; siblings by relative path).
//
// Kinds:
//   - ENUMERATED kinds carry `names`: the module's instance kind (queue managers, brokers …,
//     `module.instances.kind`, label `module.instances.label`) and `host` are always there.
//     Each gets a series `<svc>:inventory:<kind>` (vector(1), one per name, labelled
//     `<label>=<name>, environment=<env>` plus `site` when known) and `jobs`, the scrape jobs
//     whose `up` series carry that label on the live side (from the module; [] = any job).
//   - COUNTED kinds carry a `query` (PromQL, a count `by (<per>)` — e.g. queues per queue
//     manager) and optional `min` floors per parent; the inventory cannot enumerate them, so a
//     journey reports the live count and breaches only below the floor.
//
// `module.expectedKinds(ctx)` returns `{ [kind]: { title, label, jobs, names, by, query, per,
// min } }` and is merged over the two built-in kinds (a module may add `jobs` to its instance
// kind, or add counted kinds); every field is validated here.

import { metricPrefix } from '../slug.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' && v ? v : null);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BARE = /^[A-Za-z0-9_.:/-]+$/;

export const EXPECTED_SOURCE = 'gen-site inventory v1';

/**
 * Build the expected block of one environment.
 *   { pack, env, instanceKind, instances, hosts, module, ctx } → { generated_from, environment,
 *     series_prefix, kinds }
 */
export function buildExpected({ pack, env, instanceKind, instances = [], hosts = [], module = null, ctx = null } = {}) {
  const name = str(pack?.metadata?.name);
  if (!name) throw new Error('buildExpected: pack.metadata.name is required');
  const svc = metricPrefix(name);
  const prefix = `${svc}:inventory:`;
  const kind = isObj(instanceKind) ? instanceKind : { kind: 'instance', label: 'instance', title: 'instance' };
  const kinds = {};
  const enumerated = (k, title, label, items) => ({
    title, label, series: `${prefix}${k}`, jobs: [],
    names: list(items).map(i => str(i?.name)).filter(Boolean),
    by: Object.fromEntries(list(items).filter(i => str(i?.name)).map(i => [i.name, {
      site: str(i.site), hosts: list(i.hosts).map(String), shape: str(i.shape),
    }])),
  });
  kinds[kind.kind] = enumerated(kind.kind, kind.title, kind.label, instances);
  if (kind.kind !== 'host') kinds.host = enumerated('host', 'host', 'host', hosts.map(h => ({ name: h.name, site: h.site ?? null, hosts: [], shape: null })));

  const extra = typeof module?.expectedKinds === 'function' ? module.expectedKinds(ctx) : null;
  for (const [k, spec] of Object.entries(isObj(extra) ? extra : {})) {
    if (!IDENT.test(k)) throw new Error(`expectedKinds: kind ${JSON.stringify(k)} is not an identifier`);
    if (!isObj(spec)) throw new Error(`expectedKinds.${k}: must be an object`);
    const base = kinds[k] || { title: k, label: k, series: null, jobs: [], names: [], by: {} };
    const out = { ...base };
    if (spec.title !== undefined) out.title = str(spec.title) ?? base.title;
    if (spec.label !== undefined) { if (!IDENT.test(String(spec.label))) throw new Error(`expectedKinds.${k}.label must be an identifier`); out.label = spec.label; }
    if (spec.jobs !== undefined) { if (!Array.isArray(spec.jobs) || !spec.jobs.every(j => typeof j === 'string' && j)) throw new Error(`expectedKinds.${k}.jobs must be a list of job names`); out.jobs = [...spec.jobs]; }
    if (spec.names !== undefined) { if (!Array.isArray(spec.names) || !spec.names.every(n => typeof n === 'string' && n)) throw new Error(`expectedKinds.${k}.names must be a list of names`); out.names = [...spec.names]; out.series = out.series || `${prefix}${k}`; }
    if (spec.by !== undefined) { if (!isObj(spec.by)) throw new Error(`expectedKinds.${k}.by must be a mapping`); out.by = { ...base.by, ...spec.by }; }
    if (spec.query !== undefined) { if (!str(spec.query)) throw new Error(`expectedKinds.${k}.query must be a PromQL string`); out.query = spec.query; }
    if (spec.per !== undefined) { if (!IDENT.test(String(spec.per))) throw new Error(`expectedKinds.${k}.per must be a label name`); out.per = spec.per; }
    if (spec.min !== undefined) {
      if (!isObj(spec.min) || !Object.values(spec.min).every(v => Number.isInteger(v) && v >= 0)) throw new Error(`expectedKinds.${k}.min must map a parent name to a non-negative integer`);
      out.min = { ...spec.min };
    }
    if (out.query && !out.per) throw new Error(`expectedKinds.${k}: a counted kind (query) needs per: the label the count is grouped by`);
    if (!out.query && !out.names.length && !base.names.length) out.names = [];
    kinds[k] = out;
  }
  return { generated_from: EXPECTED_SOURCE, environment: env, series_prefix: prefix, kinds };
}

const yamlValue = (v) => (BARE.test(String(v)) ? String(v) : JSON.stringify(String(v)));
const flow = (obj) => `{ ${Object.entries(obj).map(([k, v]) => `${k}: ${yamlValue(v)}`).join(', ')} }`;

/**
 * The default inventory rules file of an environment: one recorded series per name of every
 * enumerated kind. A module whose templates emit `prometheus/rules/<name>.inventory.yml`
 * themselves (the IBM MQ module does, with its Silent alert) keeps its own file; run.mjs emits
 * this one only when nothing else did.
 */
export function inventoryRulesYaml({ name, env, interval = '30s', expected, extraLabels = {} } = {}) {
  const kinds = isObj(expected?.kinds) ? expected.kinds : {};
  const rules = [];
  for (const spec of Object.values(kinds)) {
    if (!spec?.series || !list(spec.names).length) continue;
    for (const n of spec.names) {
      const by = isObj(spec.by?.[n]) ? spec.by[n] : {};
      const labels = { [spec.label]: n, environment: env, ...(by.site ? { site: by.site } : {}), ...(by.shape ? { shape: by.shape } : {}), ...extraLabels };
      rules.push(`      - record: ${spec.series}\n        expr: vector(1)\n        labels: ${flow(labels)}\n`);
    }
  }
  return [
    `# Inventory of environment ${env}, GENERATED by gen-site from the site inventory: one series per`,
    `# inventoried item (${Object.values(kinds).filter((s) => s?.series && list(s.names).length).map((s) => `${s.title}${list(s.names).length === 1 ? '' : 's'} as ${s.series}`).join(', ') || 'nothing enumerated'}).`,
    '# A journey compares these against the live up series to find what is inventoried but not',
    '# reporting; a site alert can join them the same way (<series> unless on (<label>) up).',
    'groups:',
    `  - name: ${name}.inventory`,
    `    interval: ${interval}`,
    '    rules:',
    ...(rules.length ? rules.map(r => r.replace(/\n$/, '')) : ['      []']),
    '',
  ].join('\n');
}
