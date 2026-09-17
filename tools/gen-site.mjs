#!/usr/bin/env node
/**
 * tools/gen-site.mjs — render one partition per environment from the reference pack and a
 * site inventory: the derived site pack, the compiled burn-rate rules, the IBM MQ module's
 * templates and dashboards, and a site.json manifest, under <out>/<env>/.
 *
 * The generic core is vendored (vendor/observogram/lib/site/, read-only: CLAUDE.md rule 4);
 * everything MQ-specific is the module tools/site/ibmmq.mjs. This wrapper only reads files,
 * calls run() and writes what it returns: the core itself touches no file.
 *
 * Usage:
 *   node tools/gen-site.mjs --inventory <file> [--inventory <file>…] [--env <name|all>]
 *        [--pack packs/ibmmq.pack.yaml] [--module tools/site/ibmmq.mjs] [--out sites]
 *        [--registry <file> --adapter <esm>] [--check] [--dry-run] [--strict]
 *        [--repo-url <url>] [--schema <pack schema.json>]
 *
 *   --inventory  repeatable; the files are merged (hosts and queue managers concatenated,
 *                environments merged, a file-level `env` stays with its file)
 *   --env        the environment to render, or `all` (one partition per environment); may be
 *                omitted only when the merged inventory contains exactly one environment
 *   --pack       the reference pack; default: the unique `pack:` of the inventories (relative
 *                to the repository root, or to the inventory file when the root has no such
 *                file), else packs/ibmmq.pack.yaml
 *   --module     the pack module (default tools/site/ibmmq.mjs); `none` renders only the site
 *                pack, the burn rules and site.json
 *   --registry   a raw registry (JSON or YAML) turned into an inventory by the --adapter
 *                module's toInventory(raw); it goes through the same schema and semantic checks
 *   --out        output directory (default sites); files land under <out>/<env>/
 *   --check      validate, derive and self-check; write nothing
 *   --dry-run    like --check, and list the files that would be written
 *   --strict     warnings are errors (compileBurnRules warnings, a pack without
 *                spec.environments.<env>, module warnings)
 *   --repo-url   base URL for runbook links (default: the environment's repo_url, then the
 *                dashboards generator's default from package.json)
 *   --schema     the ObservabilityPack JSON schema (default: the vendored v1.2 schema)
 *
 * Exit codes: 0 ok, 1 validation or self-check failed (nothing written), 2 usage.
 * Scripts: `npm run site` (the lab), `npm run site:check` (the fleet example, --check --strict).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from '../vendor/observogram/lib/mini-yaml.mjs';
import { validateCanonical } from '../vendor/observogram/lib/validator.mjs';
import { run } from '../vendor/observogram/lib/site/run.mjs';
import * as lib from '../vendor/observogram/lib/dashboards/lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = {
  pack: 'packs/ibmmq.pack.yaml',
  module: 'tools/site/ibmmq.mjs',
  out: 'sites',
  schema: 'vendor/observogram/observability-pack.schema.json',
  inventorySchema: 'vendor/observogram/lib/site/inventory.schema.json',
};
const argv = process.argv.slice(2);
const FLAGS = new Set(['--inventory', '--env', '--pack', '--module', '--out', '--registry', '--adapter', '--repo-url', '--schema']);
const SWITCHES = new Set(['--check', '--dry-run', '--strict', '--help', '-h']);
const usage = 'usage: gen-site.mjs --inventory <file> [--inventory <file>…] [--env <name|all>] [--pack <pack.yaml>] [--module <esm>|none] [--out <dir>] [--registry <file> --adapter <esm>] [--check] [--dry-run] [--strict] [--repo-url <url>] [--schema <file>]';
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

const opts = { inventory: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') { console.log(usage); process.exit(0); }
  if (SWITCHES.has(a)) { opts[a.slice(2)] = true; continue; }
  if (!FLAGS.has(a)) die(`unknown argument ${a}\n${usage}`);
  const v = argv[++i];
  if (v === undefined || v.startsWith('--')) die(`${a} needs a value\n${usage}`);
  if (a === '--inventory') opts.inventory.push(v); else opts[a.slice(2)] = v;
}
if (!opts.inventory.length && !opts.registry) die(`at least one --inventory (or --registry with --adapter) is required\n${usage}`);
if (Boolean(opts.registry) !== Boolean(opts.adapter)) die(`--registry and --adapter go together\n${usage}`);

const read = (p, what) => { try { return readFileSync(p, 'utf8'); } catch (e) { return die(`cannot read ${what} ${p}: ${e.message}`); } };
const inventories = opts.inventory.map(p => ({ name: p, text: read(resolve(p), 'inventory') }));

// The pack: --pack, else the unique `pack:` of the inventories (a repository-root path first,
// the inventory-relative path when the root has none), else the reference pack.
let packPath = opts.pack ? resolve(opts.pack) : null;
if (!packPath) {
  const declared = [];
  for (const inv of inventories) {
    let doc; try { doc = parseYaml(inv.text); } catch { continue; }
    if (!doc?.pack) continue;
    const atRoot = resolve(ROOT, doc.pack), atFile = resolve(dirname(resolve(inv.name)), doc.pack);
    declared.push(existsSync(atRoot) ? atRoot : atFile);
  }
  const unique = [...new Set(declared)];
  if (unique.length > 1) die(`the inventories name different packs (${unique.join(', ')}): pass --pack`);
  packPath = unique[0] ?? resolve(ROOT, DEFAULTS.pack);
}
const packText = read(packPath, 'pack');
let pack; try { pack = parseYaml(packText); } catch (e) { die(`${packPath}: ${e.message}`, 1); }
const schema = JSON.parse(read(opts.schema ? resolve(opts.schema) : resolve(ROOT, DEFAULTS.schema), 'pack schema'));
const packErrors = validateCanonical(pack, schema);
if (packErrors.length) { for (const e of packErrors) console.error(`✗ ${packPath}: ${e}`); process.exit(1); }
const inventorySchema = JSON.parse(read(resolve(ROOT, DEFAULTS.inventorySchema), 'inventory schema'));

const load = async (p, what) => { try { return await import(pathToFileURL(p).href); } catch (e) { return die(`cannot load ${what} ${p}: ${e.message}`); } };
const modulePath = opts.module === 'none' ? null : opts.module ? resolve(opts.module) : resolve(ROOT, DEFAULTS.module);
const module = modulePath ? await load(modulePath, 'module') : null;
const adapter = opts.adapter ? await load(resolve(opts.adapter), 'adapter') : null;
const registry = opts.registry ? read(resolve(opts.registry), 'registry') : undefined;

const r = run({ pack, packText, schema, inventorySchema, inventories, env: opts.env ?? null, module, adapter, registry, repoUrl: opts['repo-url'] ?? null, strict: Boolean(opts.strict), lib });
for (const w of r.warnings) console.error(`warning: ${w}`);
if (r.errors.length) { for (const e of r.errors) console.error(`✗ ${e}`); process.exit(r.usage ? 2 : 1); }

const out = resolve(opts.out || DEFAULTS.out);
const write = !(opts.check || opts['dry-run']);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
for (const [env, p] of Object.entries(r.partitions)) {
  const m = p.manifest;
  console.log(`${env}: ${plural(m.queue_managers.length, 'queue manager')}, ${plural(m.hosts.length, 'host')}, ${p.files.length} files → ${write ? resolve(out, env) : '(not written)'} (step ${m.timing.step}s, vantage ${m.vantage}, profile ${m.profile}, burn ${m.burn.alerts} alerts/${m.burn.recording} recording${m.removed.length ? `, removed ${m.removed.join('; ')}` : ''})`);
  if (opts['dry-run']) for (const f of p.files) console.log(`  ${env}/${f.path}`);
  if (write) for (const f of p.files) { const target = resolve(out, env, f.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, f.content); }
}
if (r.fleet) {
  for (const f of r.fleet.files) {
    if (opts['dry-run']) console.log(`  ${f.path}`);
    if (write) { const target = resolve(out, f.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, f.content); }
  }
  console.log(`fleet: ${plural(r.fleet.files.length, 'file')}${write ? ` → ${out}` : ' (not written)'}`);
}
if (!write) console.log(`${opts.check ? 'check' : 'dry run'} ok: ${r.selected.join(', ')}`);
