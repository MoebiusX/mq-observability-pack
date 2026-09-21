// tools/lib/site/run.mjs
//
// gen-site orchestration (design §3, §5, §9.3): inventories → environments → per environment a
// timing model, a derived site pack, compiled burn-rate rules, the module's templates and
// dashboards, the expected sets and the inventory rules, a site.json manifest and the
// self-checks. Pure: run() writes nothing and returns every file as { path, content }; the CLI
// (tools/gen-site.mjs) reads and writes. Nothing here is pack-specific: the pack-specific half
// arrives as `module` (contract below).
//
// Module contract — every hook is optional and receives the ctx object first:
//   instances                          { key, kind, label, title, schema }: what an instance is
//                                      (inventory.mjs instancesOf; default key `instances`, kind
//                                      `instance`)
//   paramsSchema                       { site, host, instance }: JSON Schema fragments spliced into
//                                      the inventory schema ($defs/siteParams|hostParams|instanceParams)
//   checkInventory({ inventory, envs, hostByName, itemLabel, instanceKind })
//                                      the product's own inventory rules → error strings
//   expectedKinds(ctx)                 { kind: { title, label, jobs, names, by, query, per, min } }
//                                      merged over the built-in expected kinds (expected.mjs)
//   packSubstitutions(ctx)             [{ name, find, replace, count }] exact-count text anchors (derive.mjs)
//   packRemovals(ctx)                  [{ key, value }] list items dropped from the site pack (dropItem)
//   runbooks(ctx)                      { sliId: runbookPath } → compileBurnRules `runbooks`
//   templates(ctx)                     { path: string | (ctx) => string } or [{ path, render }]
//   perInstance(ctx, instance)         same shape, once per instance of the environment
//                                      (`perQmgr` is accepted as the legacy name)
//   boards({ pack, lib, repoUrl, site }) dashboards [{ id, file, dashboard }] (gen-dashboards' shape);
//                                      checked with checkBindings; written to grafana/dashboards/<file>
//   dashboardOptions(ctx)              the `site` object boards() receives (default: the manifest)
//   harness(ctx)                       object stored as manifest.harness (what a harness reads from site.json)
//   checks(ctx, files)                 string[] or { errors, warnings } — self-checks over the emitted files
//   fleet(ctxs)                        files map written at <out>/ (only with --env all and > 1 environment)
//
// ctx (one per environment) = {
//   env, lab, strict, environments (every selected env name),
//   envModel                            resolved EnvModel (inventory.mjs resolveEnvironments)
//   refPack, refPackText                the reference pack (object, text)
//   pack, packText                      the derived site pack (the reference pack until derivation ran)
//   timing                              timing.mjs Timing
//   vantage, profile, p (site params; `params` is an alias), endpoints, receivers, secrets,
//   repoUrl (--repo-url > envModel.repo_url > options.repoUrl), ruleLabels,
//   instances[], hosts[], instanceKind  the environment's members (instances carry env,
//                                      exporter_host and site) and the module's descriptor;
//                                      `qmgrs` is the same array under its legacy name
//   siteOf(instance)                    the site label of an instance's hosts
//   burn                                { groups, recording, forecasts, warnings, step } after compileBurnRules
//   manifest                            the site.json object after it is built (incl. `expected`)
//   lib                                 the dashboards library passed to run() (for boards())
// }
//
// Output tree per environment (paths are relative to <out>/<env>/):
//   site.json, packs/<name>.pack.yaml, prometheus/rules/<name>.burn.yml,
//   prometheus/rules/<name>.inventory.yml (unless a template emitted it), grafana/dashboards/<file>
//   plus whatever templates/perInstance return.

import { loadInventories, mergeInventories, validateInventory, resolveEnvironments, DEFAULT_INSTANCES } from './inventory.mjs';
import { timing as buildTiming, timingManifest } from './timing.mjs';
import { derivePack, GENERATED_MARKER } from './derive.mjs';
import { buildExpected, inventoryRulesYaml } from './expected.mjs';
import { compileBurnRules, toYaml, packSnippet } from '../burn-rules.mjs';
import { checkBindings } from '../dashboards/generic.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

/** Which environments a run covers. Returns { selected, error, usage } (usage: a --env problem, exit 2). */
export function selectEnvironments(envs, env) {
  const present = Object.keys(envs).filter(e => envs[e].instances.length || envs[e].hosts.length);
  if (!present.length) return { selected: [], error: 'the inventory has no hosts or instances in any environment', usage: false };
  if (env == null || env === '') {
    if (present.length === 1) return { selected: present, error: null, usage: false };
    return { selected: [], error: `--env is required: the inventory contains ${present.length} environments (${present.join(', ')}); pass one of them or --env all`, usage: true };
  }
  if (env === 'all') return { selected: present, error: null, usage: false };
  if (!present.includes(env)) return { selected: [], error: `--env ${env}: no host or instance of the inventory is in that environment (present: ${present.join(', ')})`, usage: true };
  return { selected: [env], error: null, usage: false };
}

/** Normalise a templates() / perInstance() result to [{ path, content }] rendering functions with ctx. */
function renderTemplates(result, ctx, hook) {
  const out = [];
  if (result == null) return out;
  const entries = Array.isArray(result) ? result.map(t => [t.path, t.render ?? t.content]) : Object.entries(result);
  for (const [path, r] of entries) {
    if (!path) throw new Error(`${hook}: a template without a path`);
    const content = typeof r === 'function' ? r(ctx) : r;
    if (typeof content !== 'string') throw new Error(`${hook}: ${path} did not render to a string`);
    out.push({ path, content });
  }
  return out;
}

const badPath = (p) => typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\') || p.split('/').some(seg => seg === '' || seg === '.' || seg === '..');

function addFile(files, path, content, errors) {
  if (badPath(path)) { errors.push(`file path ${JSON.stringify(path)}: must be relative, forward-slashed, without . or .. segments`); return; }
  if (files.has(path)) { errors.push(`file ${path}: emitted twice`); return; }
  files.set(path, content);
}

/**
 * run({ pack, packText, schema, inventorySchema, inventories, env, module, adapter, registry,
 *       repoUrl, strict, lib, packChosen }) → { partitions, fleet, errors, warnings, usage, selected }
 *
 * `packChosen: true` says the caller picked `pack` itself (the CLI always does: `--pack`, or
 * the unique `pack:` of the inventories resolved relative to each file), so inventories whose
 * `pack:` strings differ are not an error (design §2.1: the CLI wins).
 */
export function run({ pack, packText, schema = null, inventorySchema = null, inventories = [], env = null, module = null, adapter = null, registry = undefined, repoUrl = null, strict = false, lib = null, packChosen = false } = {}) {
  const errors = [], warnings = [];
  const fail = (usage = false) => ({ partitions: {}, fleet: null, errors, warnings, usage, selected: [] });
  if (!isObj(pack) || typeof packText !== 'string') { errors.push('run: pack (object) and packText (string) are required'); return fail(); }
  if (!inventorySchema) warnings.push('no inventory schema given: the inventory files are not schema-checked');

  const loaded = loadInventories(inventories, { schema: inventorySchema, module, adapter, registry });
  errors.push(...loaded.errors);
  if (errors.length) return fail();
  let merged;
  try { merged = mergeInventories(loaded.files, { packChosen, module }); } catch (e) { errors.push(String(e.message || e)); return fail(); }
  errors.push(...merged.errors);
  if (errors.length) return fail();
  const v = validateInventory(merged.inventory, pack, { schema: inventorySchema, module, strict });
  errors.push(...v.errors); warnings.push(...v.warnings);
  if (errors.length) return fail();
  const { envs, errors: rerr } = resolveEnvironments(merged.inventory, pack);
  errors.push(...rerr);
  if (errors.length) return fail();

  const sel = selectEnvironments(envs, env);
  if (sel.error) { errors.push(sel.error); return fail(sel.usage); }
  const selected = sel.selected;
  const name = pack.metadata.name;
  const partitions = {};
  const ctxs = [];

  for (const e of selected) {
    const envModel = envs[e];
    const perr = [], pwarn = [];
    const files = new Map();
    const instanceKind = envModel.instanceKind || { ...DEFAULT_INSTANCES };
    const ctx = {
      env: e, lab: e === 'lab', strict, environments: selected,
      envModel, refPack: pack, refPackText: packText, pack, packText,
      timing: null, vantage: envModel.vantage, profile: envModel.profile,
      p: envModel.params, params: envModel.params,
      endpoints: envModel.endpoints, receivers: envModel.receivers, secrets: envModel.secrets,
      repoUrl: repoUrl ?? envModel.repo_url ?? null, ruleLabels: envModel.rule_labels,
      instances: envModel.instances, hosts: envModel.hosts, instanceKind,
      // legacy name of the instances array (the first module called them queue managers)
      qmgrs: envModel.instances,
      siteOf: (it) => envModel.instances.find(x => x.name === (it?.name ?? it))?.site ?? null,
      burn: null, manifest: null, lib,
    };
    try {
      ctx.timing = buildTiming(pack, e, envModel, envModel.params);
    } catch (x) { perr.push(String(x.message || x)); partitions[e] = { files: [], manifest: null, warnings: pwarn, errors: perr }; errors.push(...perr.map(m => `${e}: ${m}`)); continue; }

    try {
      // --- site pack: substitutions + removals, then the burn compile, then the snippet splice
      const subs = list(module?.packSubstitutions?.(ctx));
      const removals = list(module?.packRemovals?.(ctx));
      const first = derivePack(packText, subs, removals, { schema });
      if (first.errors.length) { perr.push(...first.errors); throw new Error('site pack derivation failed'); }
      const burn = compileBurnRules(first.pack, { step: ctx.timing.step, lab: ctx.lab, runbooks: module?.runbooks?.(ctx) || {}, minBadSamples: ctx.timing.minBadSamples });
      ctx.burn = burn;
      for (const w of burn.warnings) pwarn.push(`compileBurnRules: ${w}`);
      const hasMarker = packText.split('\n').some(l => l.trim().startsWith('#') && l.includes(GENERATED_MARKER));
      const final = hasMarker ? derivePack(packText, subs, removals, { schema, snippet: packSnippet(burn.recording) }) : first;
      if (!hasMarker) pwarn.push(`the pack has no "${GENERATED_MARKER}" marker in spec.queries.recording_rules: the error-budget recording rules are not spliced into the site pack`);
      if (final.errors.length) { perr.push(...final.errors); throw new Error('site pack derivation failed'); }
      ctx.pack = final.pack; ctx.packText = final.text;
      perr.push(...ctx.timing.assertBurnFor(burn.groups));
      addFile(files, `packs/${name}.pack.yaml`, final.text, perr);
      const header = [
        `# GENERATED by gen-site for environment ${e} from the ${name} pack (spec.policy) — do not edit.`,
        '# Multi-window burn-rate alerts (one per declared window), forecast alerts and the',
        '# error-budget recording rules. Names/labels follow compile.mjs; burn-rules.mjs lists the',
        `# PromQL deviations. Sample step ${burn.step}s, for: ${ctx.lab ? 'lab' : 'production'}.`,
        '',
      ];
      addFile(files, `prometheus/rules/${name}.burn.yml`, toYaml(burn.groups, header), perr);

      // --- manifest (built before templates so they can read it through ctx.manifest)
      const instancesOut = envModel.instances.map(it => ({ name: it.name, env: it.env, shape: it.shape ?? null, hosts: it.hosts ?? [], address: it.address ?? null, exporter_host: it.exporter_host ?? null, site: it.site ?? null, params: it.params ?? {} }));
      const manifest = {
        generator: 'gen-site', inventory: 'v1', environment: e,
        pack: { name, version: pack.metadata.version, file: `packs/${name}.pack.yaml` },
        vantage: ctx.vantage, profile: ctx.profile, scrape_interval: envModel.scrape_interval,
        timing: timingManifest(ctx.timing),
        endpoints: ctx.endpoints, receivers: ctx.receivers, secrets: ctx.secrets, repo_url: ctx.repoUrl, rule_labels: ctx.ruleLabels,
        params: ctx.p,
        hosts: envModel.hosts.map(h => ({ name: h.name, env: h.env, site: h.site ?? null, roles: h.roles ?? [], params: h.params ?? {} })),
        instance_kind: { ...instanceKind },
        instances: instancesOut,
        // the same list under the module's own key, for readers that know the product's name for it
        ...(instanceKind.key !== DEFAULT_INSTANCES.key ? { [instanceKind.key]: instancesOut } : {}),
        expected: buildExpected({ pack, env: e, instanceKind, instances: envModel.instances, hosts: envModel.hosts, module, ctx }),
        burn: { recording: burn.recording.length, alerts: burn.burnCount, forecasts: burn.forecasts.length, minBadSamples: ctx.timing.minBadSamples, lab: ctx.lab, step: burn.step },
        removed: final.removed, substitutions: final.applied,
        harness: module?.harness?.(ctx) ?? null,
        files: [],
      };
      ctx.manifest = manifest;

      // --- templates, per instance, dashboards, then the default inventory rules
      for (const f of renderTemplates(module?.templates?.(ctx), ctx, 'templates')) addFile(files, f.path, f.content, perr);
      const perInstance = module?.perInstance ?? module?.perQmgr;
      if (typeof perInstance === 'function') for (const it of envModel.instances) for (const f of renderTemplates(perInstance(ctx, it), ctx, `perInstance(${it.name})`)) addFile(files, f.path, f.content, perr);
      if (module?.boards) {
        const site = module.dashboardOptions?.(ctx) ?? manifest;
        const boards = list(module.boards({ pack: ctx.pack, lib, repoUrl: ctx.repoUrl, site }));
        for (const p of checkBindings(ctx.pack, boards)) perr.push(`dashboards: ${p}`);
        for (const b of boards) addFile(files, `grafana/dashboards/${b.file}`, JSON.stringify(b.dashboard, null, 2) + '\n', perr);
      }
      const inventoryRulesPath = `prometheus/rules/${name}.inventory.yml`;
      if (!files.has(inventoryRulesPath)) {
        addFile(files, inventoryRulesPath, inventoryRulesYaml({ name, env: e, interval: ctx.timing.dur(ctx.timing.interval), expected: manifest.expected }), perr);
      }
      manifest.files = [...files.keys()].sort();
      addFile(files, 'site.json', JSON.stringify(manifest, null, 2) + '\n', perr);

      // --- self-checks
      const emitted = [...files].map(([path, content]) => ({ path, content }));
      const c = module?.checks?.(ctx, emitted);
      if (Array.isArray(c)) perr.push(...c.map(String));
      else if (isObj(c)) { perr.push(...list(c.errors).map(String)); pwarn.push(...list(c.warnings).map(String)); }
      if (strict && pwarn.length) { perr.push(...pwarn.map(w => `(strict) ${w}`)); pwarn.length = 0; }
      partitions[e] = { files: perr.length ? [] : emitted, manifest, warnings: pwarn, errors: perr };
    } catch (x) {
      if (!perr.length || !/derivation failed/.test(String(x.message))) perr.push(String(x.message || x));
      partitions[e] = { files: [], manifest: ctx.manifest, warnings: pwarn, errors: perr };
    }
    errors.push(...perr.map(m => `${e}: ${m}`));
    warnings.push(...pwarn.map(m => `${e}: ${m}`));
    ctxs.push(ctx);
  }

  let fleet = null;
  if (!errors.length && env === 'all' && selected.length > 1 && module?.fleet) {
    const files = new Map();
    const ferr = [];
    try { for (const f of renderTemplates(module.fleet(ctxs), ctxs, 'fleet')) addFile(files, f.path, f.content, ferr); } catch (x) { ferr.push(String(x.message || x)); }
    errors.push(...ferr.map(m => `fleet: ${m}`));
    fleet = { files: [...files].map(([path, content]) => ({ path, content })) };
  }
  if (errors.length) return { partitions, fleet: null, errors, warnings, usage: false, selected };
  return { partitions, fleet, errors, warnings, usage: false, selected };
}
