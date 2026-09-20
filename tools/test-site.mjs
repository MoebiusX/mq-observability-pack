#!/usr/bin/env node
/**
 * tools/test-site.mjs — gen-site regression suite for the IBM MQ module (design §9.1), run by
 * `npm test` (node:test, no dependencies). Static only: nothing here touches the live lab.
 *
 *   T1  merge: the fleet example split into a prod file (file-level env) and a staging file
 *       merges back into the same model; a duplicate queue manager in one environment is an error
 *   T2  inheritance: qm env from its hosts; disagreeing hosts and an orphan host are errors
 *   T3  names: an environment outside metadata.bindings.environments is an error quoting the
 *       pack's list [prod, staging, lab] (item env and environments.<env> block)
 *   T4  --env prod: the pack text carries the production timing ([90s], scrape_interval: 30s,
 *       interval: 30s ×11, chaos environment: prod, rebudgeted expected_mttd, the labelled
 *       static_configs) and the burn file the declared for: (2m / 5m / 10m)
 *   T5  the CLI: --env all writes <out>/prod and <out>/staging and nothing else; --env omitted
 *       with two environments exits 2; --check and --dry-run write nothing
 *   T8  an anchor whose count differs fails naming the anchor (a modified pack through --pack)
 *   T9  staging (vantage single): seven SLOs, no qmgr_process_up, no ibmmq-native job, no
 *       qmgr-down experiment; the burn file has no process rules
 *   T10 lab round trip: the lab site pack is byte-identical to packs/ibmmq.pack.yaml, the lab
 *       burn rules equal stack/prometheus/rules/ibmmq.burn.yml below the header comment, the four
 *       boards equal stack/grafana/dashboards/*.json; the adapter sample round-trips through
 *       --registry/--adapter --check and names the same queue managers as the fleet example
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from '../vendor/observogram/lib/mini-yaml.mjs';
import { loadInventories, mergeInventories, resolveEnvironments, validateInventory } from '../vendor/observogram/lib/site/inventory.mjs';
import { countMatches } from '../vendor/observogram/lib/site/derive.mjs';
import { run } from '../vendor/observogram/lib/site/run.mjs';
import * as lib from '../vendor/observogram/lib/dashboards/lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const schema = JSON.parse(rd('vendor/observogram/observability-pack.schema.json'));
const invSchema = JSON.parse(rd('vendor/observogram/lib/site/inventory.schema.json'));
const packText = rd('packs/ibmmq.pack.yaml');
const pack = parseYaml(packText);
const module = await import(pathToFileURL(resolve(ROOT, 'tools/site/ibmmq.mjs')).href);
const fleetText = rd('sites/fleet-example.inventory.yaml');
const labText = rd('sites/lab.inventory.yaml');
const fleetDoc = parseYaml(fleetText);
const ENVS = '[prod, staging, lab]';
const files = (...docs) => docs.map((d, i) => ({ name: `f${i}.yaml`, doc: d }));
const loadAll = (inputs) => loadInventories(inputs, { schema: invSchema, module });
const runWith = (inventories, env, extra = {}) => run({ pack, packText, schema, inventorySchema: invSchema, inventories, env, module, lib, ...extra });
const stripHeader = (t) => t.split('\n').filter(l => !l.startsWith('#')).join('\n');

// the fleet example as two files: prod with a file-level env, staging with per-item envs
const byEnv = (env, fileEnv) => ({
  inventory: 'v1', pack: 'packs/ibmmq.pack.yaml', ...(fileEnv ? { env } : {}),
  environments: { [env]: fleetDoc.environments[env] },
  hosts: fleetDoc.hosts.filter(h => h.env === env).map(h => (fileEnv ? Object.fromEntries(Object.entries(h).filter(([k]) => k !== 'env')) : h)),
  queue_managers: fleetDoc.queue_managers.filter(q => (q.env ?? fleetDoc.hosts.find(h => h.name === q.hosts[0]).env) === env),
});

// ----------------------------------------------------------------- T1 merge
test('T1 merge: prod file (file-level env) + staging file = the fleet example', () => {
  const l = loadAll([{ name: 'prod.yaml', doc: byEnv('prod', true) }, { name: 'staging.yaml', doc: byEnv('staging', false) }]);
  assert.deepEqual(l.errors, []);
  const m = mergeInventories(l.files);
  assert.deepEqual(m.errors, []);
  assert.equal(m.inventory.hosts.length, 5);
  assert.deepEqual(m.inventory.queue_managers.map(q => q.name), ['QMORD1', 'QMPAY1', 'QMORDS']);
  assert.deepEqual(Object.keys(m.inventory.environments).sort(), ['prod', 'staging']);
  assert.deepEqual(m.inventory.queue_managers[0].source, { file: 'prod.yaml', env: 'prod' });
  const v = validateInventory(m.inventory, pack, { schema: invSchema, module });
  assert.deepEqual(v.errors, []);
  const { envs, errors } = resolveEnvironments(m.inventory, pack);
  assert.deepEqual(errors, []);
  const single = resolveEnvironments(mergeInventories(loadAll([{ name: 'fleet.yaml', text: fleetText }]).files).inventory, pack).envs;
  for (const e of ['prod', 'staging']) {
    assert.deepEqual(envs[e].queue_managers.map(q => [q.name, q.env, q.exporter_host, q.site]), single[e].queue_managers.map(q => [q.name, q.env, q.exporter_host, q.site]));
    assert.deepEqual(envs[e].hosts.map(h => h.name), single[e].hosts.map(h => h.name));
  }
  assert.equal(envs.prod.queue_managers[0].exporter_host, 'mon1.prod.internal');
  assert.equal(envs.prod.queue_managers[0].site, 'dc1');
});

test('T1 merge: a queue manager declared twice in one environment is an error naming both files', () => {
  const a = { inventory: 'v1', env: 'prod', queue_managers: [{ name: 'QM1', shape: 'host' }] };
  const b = { inventory: 'v1', env: 'prod', queue_managers: [{ name: 'QM1', shape: 'host' }] };
  const m = mergeInventories([{ name: 'a.yaml', doc: a }, { name: 'b.yaml', doc: b }]);
  const all = [...m.errors, ...resolveEnvironments(m.inventory, pack).errors, ...validateInventory(m.inventory, pack, { module }).errors];
  assert.ok(all.some(e => /queue manager QM1/.test(e) && /a\.yaml/.test(e) && /b\.yaml/.test(e)), all.join('\n'));
});

// ----------------------------------------------------------------- T2 inheritance
test('T2 inheritance: a queue manager without env takes the unique env of its hosts', () => {
  const doc = { inventory: 'v1', env: 'lab', environments: { prod: fleetDoc.environments.prod, lab: {} }, hosts: [{ name: 'h1', env: 'prod' }, { name: 'h2', env: 'prod' }], queue_managers: [{ name: 'Q', shape: 'host', hosts: ['h1', 'h2'] }] };
  const { envs, errors } = resolveEnvironments(mergeInventories(files(doc)).inventory, pack);
  assert.deepEqual(errors, []);
  assert.equal(envs.prod.queue_managers[0].env, 'prod');
  assert.equal(envs.lab, undefined);
});

test('T2 inheritance: hosts that disagree, qm.env that differs from its hosts, and an orphan host are errors naming the items', () => {
  const disagree = { inventory: 'v1', environments: { prod: {}, staging: {} }, hosts: [{ name: 'h1', env: 'prod' }, { name: 'h2', env: 'staging' }], queue_managers: [{ name: 'Q', shape: 'host', hosts: ['h1', 'h2'] }] };
  assert.match(resolveEnvironments(mergeInventories(files(disagree)).inventory, pack).errors[0], /queue manager Q \(f0\.yaml\): its hosts disagree on env: h1=prod, h2=staging/);
  const differs = { inventory: 'v1', environments: { prod: {}, staging: {} }, hosts: [{ name: 'h1', env: 'prod' }], queue_managers: [{ name: 'Q', env: 'staging', shape: 'host', hosts: ['h1'] }] };
  assert.match(resolveEnvironments(mergeInventories(files(differs)).inventory, pack).errors[0], /queue manager Q \(f0\.yaml\): env staging differs from its hosts' env prod \(h1\)/);
  const orphan = { inventory: 'v1', environments: { prod: {} }, hosts: [{ name: 'orphan' }], queue_managers: [{ name: 'Q', shape: 'host', hosts: ['orphan'] }] };
  const errors = resolveEnvironments(mergeInventories(files(orphan)).inventory, pack).errors;
  assert.ok(errors.some(e => /host orphan \(f0\.yaml\): no env and its file declares none/.test(e)), errors.join('\n'));
});

// ----------------------------------------------------------------- T3 names
test('T3 names: an environment outside metadata.bindings.environments is an error quoting the pack list', () => {
  const item = { inventory: 'v1', env: 'uat', environments: { uat: { endpoints: { remote_write: 'http://x' }, params: fleetDoc.environments.staging.params } }, hosts: [{ name: 'h1' }], queue_managers: [{ name: 'Q', shape: 'host', hosts: ['h1'], params: fleetDoc.queue_managers[2].params }] };
  const v = validateInventory(mergeInventories(files(item)).inventory, pack, { schema: invSchema, module });
  assert.ok(v.errors.includes(`environment uat: not in the pack's metadata.bindings.environments ${ENVS}`), v.errors.join('\n'));
  const block = { inventory: 'v1', env: 'lab', environments: { lab: parseYaml(labText).environments.lab, uat: {} }, hosts: [{ name: 'mq' }], queue_managers: [{ name: 'QM1', shape: 'container', hosts: ['mq'], params: parseYaml(labText).queue_managers[0].params }] };
  const w = validateInventory(mergeInventories(files(block)).inventory, pack, { schema: invSchema, module });
  assert.ok(w.errors.includes(`environment uat: not in the pack's metadata.bindings.environments ${ENVS}`), w.errors.join('\n'));
  assert.deepEqual(w.errors.filter(e => !/uat/.test(e)), []);
});

test('schema: the module params are enforced (unknown site param, wrong port type, missing required instance params)', () => {
  const bad = parseYaml(labText);
  bad.environments.lab.params.typo = 1;
  bad.queue_managers[0].params.client_port = 'nope';
  delete bad.queue_managers[0].params.credentials;
  const l = loadAll([{ name: 'bad.yaml', doc: bad }]);
  assert.ok(l.errors.some(e => /environments\.lab\.params: unknown property 'typo'/.test(e)), l.errors.join('\n'));
  assert.ok(l.errors.some(e => /client_port: expected integer/.test(e)), l.errors.join('\n'));
  assert.ok(l.errors.some(e => /params: missing required key 'credentials'/.test(e)), l.errors.join('\n'));
  assert.deepEqual(loadAll([{ name: 'lab.yaml', text: labText }, { name: 'fleet.yaml', text: fleetText }]).errors, []);
});

// ----------------------------------------------------------------- T4 prod timing
const fleet = [{ name: 'sites/fleet-example.inventory.yaml', text: fleetText }];
test('T4 --env prod: the site pack and the burn rules carry the production timing', () => {
  const r = runWith(fleet, 'prod');
  assert.deepEqual(r.errors, []); assert.deepEqual(r.warnings, []);
  const p = r.partitions.prod;
  const text = p.files.find(f => f.path === 'packs/ibmmq.pack.yaml').content;
  assert.equal(countMatches(text, '[90s]'), 6, 'five SLI windows and the comment that explains them');
  assert.equal(countMatches(text, '[30s]'), 0);
  assert.equal(countMatches(text, 'scrape_interval: 30s'), 4, 'native, exporter, certification (max(30s, step)) and the prod override');
  assert.equal(countMatches(text, 'scrape_interval: 10s'), 0);
  assert.equal(countMatches(text, 'interval: 30s }'), 11);
  assert.equal(countMatches(text, '\n        environment: prod'), 5, 'the five chaos experiments');
  assert.equal(countMatches(text, 'environment: prod'), 10, 'plus the five labelled static_configs entries');
  assert.equal(countMatches(text, 'environment: lab'), 0);
  // the inventory's regex ORD\..*|PAY\..* lands PromQL-escaped (a doubled backslash) inside the double-quoted matcher
  assert.equal(countMatches(text, 'queue=~"ORD\\\\..*|PAY\\\\..*"'), 3);
  assert.equal(countMatches(text, 'queue=~"ORD\\..*|PAY\\..*"'), 0, 'an unescaped backslash is an unknown escape sequence to promtool');
  assert.equal(countMatches(text, 'queue="SYSTEM.DEAD.LETTER.QUEUE"'), 1);
  assert.equal(countMatches(text, 'queue!="SYSTEM.DEAD.LETTER.QUEUE"'), 1);
  assert.ok(text.includes('- targets: [10.20.5.11:9157]\n                labels: { qmgr: QMORD1, environment: prod, site: dc1, shape: rdqm-ha, source: native }'));
  assert.ok(text.includes('- targets: [mon1.prod.internal:9162]\n                labels: { qmgr: QMPAY1, environment: prod, site: dc2, shape: host, source: exporter }'));
  assert.ok(text.includes('- targets: [alert-sink.mq-obs.svc:9095]\n                labels: { environment: prod }'));
  assert.ok(text.includes('value: "prod"') && !text.includes('${ENV}') && !text.includes('key: mq.qmgr.name'), 'resource attributes: literal environment, no qmgr name with two queue managers');
  assert.ok(text.includes('endpoint: https://mimir.prod.internal/api/v1/push') && text.includes('endpoints: [https://loki.prod.internal/otlp]') && text.includes('endpoint: tempo.prod.internal:4317'));
  assert.equal(countMatches(text, 'webhook: "http://alert-sink.mq-obs.svc:9095/webhook"'), 3);
  assert.ok(text.includes('target: 10.20.5.11(1414)/MON.CANARY\n        interval: 30s'));
  assert.ok(!text.includes('orders-flow'), 'S4 dropped: orders_queue is null');
  // chaos rebudget: lab + (2m − 20s) + (30s − 5s) + 2·(30s − 10s)
  const chaos = parseYaml(text).spec.validation.chaos_experiments;
  assert.deepEqual(chaos.map(c => [c.id, c.expected_mttd, c.environment]), [['qmgr-down', '255s', 'prod'], ['listener-stopped', '255s', 'prod'], ['queue-full', '225s', 'prod'], ['consumer-stall', '315s', 'prod'], ['dlq-poison', '225s', 'prod']]);
  // the generated block is re-spliced at the site step
  assert.ok(text.includes('[5m:30s]') && text.includes('[1h:30s]') && !text.includes('[5m:10s]'));
  const burn = parseYaml(p.files.find(f => f.path === 'prometheus/rules/ibmmq.burn.yml').content);
  const rules = burn.groups.flatMap(g => g.rules);
  const fors = Object.fromEntries(rules.filter(x => x.alert && x.labels?.window_short).map(x => [x.alert, x.for]));
  assert.equal(fors.qmgr_process_up_99_9_burn_14x_5m_1h, '2m'); assert.equal(fors.qmgr_process_up_99_9_burn_6x_30m_6h, '5m');
  assert.equal(fors.message_age_99_under_60s_burn_4x_1h_6h, '10m'); assert.equal(fors.log_latency_99_under_20ms_burn_8x_15m_2h, '5m');
  const recorded = rules.filter(x => x.record).map(x => x.expr);
  assert.deepEqual(parseYaml(text).spec.queries.recording_rules.filter(x => x.labels?.slo).map(x => x.expr), recorded, 'pack snippet and burn file agree (what check-rules compares)');
  assert.ok(recorded.every(e => !/:10s\]/.test(e)));
  const m = p.manifest;
  assert.equal(m.timing.step, 30); assert.equal(m.timing.rendered.window3, '90s'); assert.equal(m.timing.probe, 30);
  assert.deepEqual(m.harness.families.find(f => f[1] === 'ibmmq-native'), ['ibmmq_qmgr_commit_count', 'ibmmq-native'], 'non-container: the local exporter counter name');
  assert.deepEqual(m.harness.services, ['ibmmq', 'mq-canary']);
  assert.deepEqual(m.harness.names.svrconns, ['MON.SVRCONN', 'CANARY.SVRCONN']);
  assert.equal(m.repo_url, 'https://github.com/MoebiusX/mq-observability-pack/blob/main');
  assert.equal(m.burn.alerts, 14); assert.equal(m.burn.lab, false);
  // every anchor changed something for prod except one identity: the certification job keeps
  // max(30 s, step), which is the lab literal at a 30 s step
  assert.deepEqual(m.substitutions.filter(s => !s.changed).map(s => s.name), ['certification scrape_interval']);
});

// ----------------------------------------------------------------- T9 staging (vantage single)
test('T9 staging (vantage single): the degraded site pack', () => {
  const r = runWith(fleet, 'staging');
  assert.deepEqual(r.errors, []);
  const p = r.partitions.staging;
  const text = p.files.find(f => f.path === 'packs/ibmmq.pack.yaml').content;
  const sp = parseYaml(text);
  assert.equal(sp.spec.slos.length, 7);
  assert.ok(!sp.spec.slis.some(s => s.id === 'qmgr_process_up') && !sp.spec.slos.some(s => s.id === 'qmgr_process_up_99_9'));
  assert.ok(!sp.spec.policy.burn_rate_alerts.some(b => b.slo === 'qmgr_process_up_99_9') && !sp.spec.policy.forecasts.some(f => f.slo === 'qmgr_process_up_99_9'));
  assert.ok(!sp.spec.remediation.some(x => x.trigger === 'alert:ibmmq-queue-manager-down'));
  assert.ok(!sp.spec.validation.chaos_experiments.some(x => x.id === 'qmgr-down'));
  const jobs = sp.spec.pipelines.receivers.find(x => x.name === 'prometheus').scrape_configs.map(s => s.job_name);
  assert.deepEqual(jobs, ['ibmmq-exporter', 'certification']);
  for (const needle of ['id: qmgr_process_up', 'slis.qmgr_process_up', 'slo: qmgr_process_up_99_9', 'ref:slos.qmgr_process_up_99_9', 'ibmmq:qmgr_process_up:', 'sli: qmgr_process_up', 'job_name: ibmmq-native']) {
    assert.equal(countMatches(text, needle), 0, `no structural reference to the process SLI survives: ${needle}`);
  }
  for (const d of sp.spec.dashboards) assert.ok(!(d.panel_bindings || []).some(b => /qmgr_process_up/.test(b.binds_to)));
  assert.ok(text.includes('value: "QMORDS"') && text.includes('value: "staging"'));
  const burn = parseYaml(p.files.find(f => f.path === 'prometheus/rules/ibmmq.burn.yml').content);
  const names = burn.groups.flatMap(g => g.rules).map(x => x.alert || x.record).concat(burn.groups.flatMap(g => g.rules).map(x => x.labels?.slo));
  assert.ok(!names.some(n => /qmgr_process_up/.test(String(n))));
  assert.equal(p.manifest.burn.alerts, 12);
  assert.ok(!p.manifest.harness.families.some(f => f[1] === 'ibmmq-native'));
  assert.equal(p.manifest.scrape_interval, null); assert.equal(p.manifest.timing.step, 10, 'no inventory interval and no staging override: the pack step');
});

// ----------------------------------------------------------------- T8 anchor counts
const CLI = resolve(ROOT, 'tools/gen-site.mjs');
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });

test('T8 counts: a pack with one more [30s] fails naming the anchor (through --pack); a missing removal target names the item', () => {
  const out = mkdtempSync(join(tmpdir(), 'mq-site-'));
  try {
    const extra = join(out, 'extra.pack.yaml');
    writeFileSync(extra, packText.replace('threshold: 0.8', 'threshold: 0.8   # [30s]'));
    const r = cli('--inventory', 'sites/fleet-example.inventory.yaml', '--pack', extra, '--env', 'prod', '--check', '--out', join(out, 'never'));
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /prod: anchor window3: expected 6 occurrences, found 7/);
    assert.ok(!existsSync(join(out, 'never')));
    const r2 = runWith(fleet, 'staging', { pack: parseYaml(packText.replace('- id: qmgr-down', '- id: qmgr-halt')), packText: packText.replace('- id: qmgr-down', '- id: qmgr-halt') });
    assert.ok(r2.errors.some(e => /staging: dropItem: no list item with id: qmgr-down/.test(e)), r2.errors.join('\n'));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// ----------------------------------------------------------------- T5 the CLI
test('T5 CLI: --env all partitions prod and staging; --env omitted with two environments exits 2; --check/--dry-run write nothing', () => {
  const out = mkdtempSync(join(tmpdir(), 'mq-site-'));
  try {
    const r = cli('--inventory', 'sites/fleet-example.inventory.yaml', '--env', 'all', '--out', out);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(readdirSync(out).sort(), ['alertmanager.fleet.yml', 'prod', 'staging']);
    for (const e of ['prod', 'staging']) for (const f of ['site.json', 'packs/ibmmq.pack.yaml', 'prometheus/rules/ibmmq.burn.yml', 'grafana/dashboards/ibmmq-unified.json']) assert.ok(existsSync(join(out, e, f)), `${e}/${f}`);
    assert.match(r.stdout, /^prod: 2 queue managers, 4 hosts, 21 files → /m);
    assert.match(r.stdout, /^staging: 1 queue manager, 1 host, 19 files → .*vantage single/m);
    assert.ok(existsSync(join(out, 'alertmanager.fleet.yml')), 'the fleet Alertmanager file at <out>/');
    assert.equal(JSON.parse(readFileSync(join(out, 'staging', 'site.json'), 'utf8')).environment, 'staging');
    const omitted = cli('--inventory', 'sites/fleet-example.inventory.yaml', '--check');
    assert.equal(omitted.status, 2, omitted.stderr);
    assert.match(omitted.stderr, /--env is required: the inventory contains 2 environments \(prod, staging\)/);
    const dry = cli('--inventory', 'sites/fleet-example.inventory.yaml', '--env', 'all', '--dry-run', '--strict', '--out', join(out, 'never'));
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(!existsSync(join(out, 'never')));
    assert.match(dry.stdout, /^ {2}prod\/site\.json$/m); assert.match(dry.stdout, /dry run ok: prod, staging/);
    const check = cli('--inventory', 'sites/lab.inventory.yaml', '--check', '--out', join(out, 'never'));
    assert.equal(check.status, 0, check.stderr); assert.match(check.stdout, /check ok: lab/); assert.ok(!existsSync(join(out, 'never')));
    assert.equal(cli('--inventory', 'sites/fleet-example.inventory.yaml', '--env', 'lab', '--check').status, 2, 'an environment without members is a usage error');
    assert.equal(cli('--bogus').status, 2);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// ----------------------------------------------------------------- T10 lab round trip
test('T10 lab: the site pack equals the reference pack byte for byte; burn rules and boards equal stack/', () => {
  const r = runWith([{ name: 'sites/lab.inventory.yaml', text: labText }], 'lab');
  assert.deepEqual(r.errors, []); assert.deepEqual(r.warnings, []);
  const lab = r.partitions.lab;
  assert.equal(lab.files.find(f => f.path === 'packs/ibmmq.pack.yaml').content, packText);
  assert.ok(lab.manifest.substitutions.every(s => s.changed === false), 'every anchor maps a value to itself');
  assert.deepEqual(lab.manifest.removed, []);
  // the core writes its own header comment; the rules below it are the stack's
  assert.equal(stripHeader(lab.files.find(f => f.path === 'prometheus/rules/ibmmq.burn.yml').content), stripHeader(rd('stack/prometheus/rules/ibmmq.burn.yml')));
  for (const f of ['ibmmq-unified', 'ibmmq-overview', 'ibmmq-queues', 'ibmmq-slo-burn']) {
    assert.equal(lab.files.find(x => x.path === `grafana/dashboards/${f}.json`).content, rd(`stack/grafana/dashboards/${f}.json`), f);
  }
  assert.deepEqual(lab.manifest.harness.families.find(f => f[1] === 'ibmmq-native'), ['ibmmq_qmgr_commit_total', 'ibmmq-native']);
  assert.deepEqual(lab.manifest.harness.services, ['ibmmq', 'mq-canary', 'orders-producer', 'orders-consumer']);
  assert.deepEqual(lab.manifest.harness.names.svrconns, ['DEV.ADMIN.SVRCONN', 'DEV.APP.SVRCONN']);
  assert.equal(lab.manifest.timing.rendered.gate, '1m'); assert.equal(lab.manifest.burn.lab, true);
});

test('T10 adapter: the registry sample round-trips through --registry/--adapter and names the fleet example queue managers', async () => {
  const adapter = await import(pathToFileURL(resolve(ROOT, 'tools/site/adapters/example.mjs')).href);
  const raw = JSON.parse(rd('tools/site/adapters/example.registry.json'));
  const inv = adapter.toInventory(raw);
  assert.equal(inv.inventory, 'v1');
  assert.deepEqual(inv.queue_managers.map(q => [q.name, q.env, q.shape, q.hosts.length]), [['QMORD1', 'prod', 'rdqm-ha', 3], ['QMPAY1', 'prod', 'host', 1], ['QMORDS', 'staging', 'host', 1]]);
  assert.deepEqual(inv.queue_managers[0].address, { host: '10.20.5.11', port: 1414 });
  assert.deepEqual(inv.queue_managers[0].params.rdqm, { group: 'ord', dr: false });
  assert.equal(inv.queue_managers[2].params.native_port, undefined);
  assert.deepEqual(inv.hosts.map(h => h.name), fleetDoc.hosts.map(h => h.name));
  const r = run({ pack, packText, schema, inventorySchema: invSchema, inventories: [], env: 'all', module, lib, adapter, registry: rd('tools/site/adapters/example.registry.json') });
  assert.deepEqual(r.errors, []);
  const viaFile = runWith(fleet, 'all');
  for (const e of ['prod', 'staging']) {
    assert.deepEqual(r.partitions[e].manifest.queue_managers.map(q => q.name), viaFile.partitions[e].manifest.queue_managers.map(q => q.name));
    assert.equal(r.partitions[e].files.find(f => f.path === 'packs/ibmmq.pack.yaml').content, viaFile.partitions[e].files.find(f => f.path === 'packs/ibmmq.pack.yaml').content, `${e}: the same site pack from the registry and from the inventory file`);
  }
  const c = cli('--registry', 'tools/site/adapters/example.registry.json', '--adapter', 'tools/site/adapters/example.mjs', '--env', 'all', '--check', '--strict');
  assert.equal(c.status, 0, c.stderr + c.stdout);
  assert.match(c.stdout, /check ok: prod, staging/);
  assert.throws(() => adapter.toInventory([{ host: 'h', qmgr: 'Q', env: 'uat' }]), /no environment wiring for uat/);
  assert.throws(() => adapter.toInventory([{ host: 'h', qmgr: 'Q' }]), /row 0: missing env/);
});

// ----------------------------------------------------------------- T10 templates: the lab round trip
const labRun = () => runWith([{ name: 'sites/lab.inventory.yaml', text: labText }], 'lab');
const fileOf = (p, path) => { const f = p.files.find(x => x.path === path); assert.ok(f, `${path} rendered`); return f.content; };
/** The reference text after exact, once-only replacements: the asserted deviation is a transformation, never an ignore list. */
const expectDeviation = (text, replacements) => replacements.reduce((acc, [from, to]) => {
  assert.equal(countMatches(acc, from), 1, `deviation anchor occurs once: ${from}`);
  return acc.split(from).join(to);
}, text);
/** The &canary_env block of docker-compose.yaml as { KEY: value } with `${VAR:-default}` resolved to its default. */
const composeCanaryEnv = () => {
  const lines = rd('docker-compose.yaml').split('\n');
  const start = lines.findIndex(l => /environment: &canary_env/.test(l));
  assert.ok(start > 0, 'docker-compose.yaml has the &canary_env block');
  const out = {};
  for (const l of lines.slice(start + 1)) {
    const m = /^\s{6}([A-Z_]+): (.*)$/.exec(l);
    if (!m) break;
    out[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/\$\{[A-Z_]+:-([^}]*)\}/g, '$1');
  }
  return out;
};

// The lab is a rendered site: every generated file with a twin under stack/ is byte-identical.
// (The transition commit brought the collector, Prometheus and Alertmanager files to their
// rendering: target labels environment/site/shape, literal resource attributes, the remote-write
// and Prometheus external label environment=lab, the environment matcher on the SEV1 route, and
// the new inventory rules file; each was validated statically and the lab recertified live.)
const LAB_TWINS = [
  ['prometheus/prometheus.yml', 'stack/prometheus/prometheus.yml'],
  ['prometheus/rules/ibmmq.recording.yml', 'stack/prometheus/rules/ibmmq.recording.yml'],
  ['prometheus/rules/ibmmq.alerts.yml', 'stack/prometheus/rules/ibmmq.alerts.yml'],
  ['prometheus/rules/ibmmq.inventory.yml', 'stack/prometheus/rules/ibmmq.inventory.yml'],
  ['prometheus/tests/ibmmq.alerts.test.yml', 'stack/prometheus/tests/ibmmq.alerts.test.yml'],
  ['otelcol/config.yaml', 'stack/otelcol/config.yaml'],
  ['alertmanager/alertmanager.yml', 'stack/alertmanager/alertmanager.yml'],
  ['grafana/provisioning/datasources/datasources.yaml', 'stack/grafana/provisioning/datasources/datasources.yaml'],
  ['qmgrs/QM1/mq_prometheus.yaml', 'stack/mq-exporter/mq_prometheus.yaml'],
];
test('T10 templates: every rendered lab file with a stack twin is byte-identical to stack/', () => {
  const lab = labRun().partitions.lab;
  for (const [g, s] of LAB_TWINS) assert.equal(fileOf(lab, g), rd(s), g);
  assert.deepEqual(lab.manifest.skipped ?? [], [], 'every template applies to the lab');
});

test('T10 templates: the environment wiring the lab carries (what the transition added, now asserted on stack/)', () => {
  const lab = labRun().partitions.lab;
  const otel = fileOf(lab, 'otelcol/config.yaml');
  for (const needle of [
    'labels: { qmgr: "QM1", environment: lab, site: lab, shape: container, source: native }',
    'labels: { environment: lab, site: lab, shape: container, source: exporter }',
    '- targets: [ "alert-sink:9095" ]\n              labels: { environment: lab }\n',
    '{ key: deployment.environment, value: "lab", action: upsert }',
    '{ key: mq.qmgr.name,           value: "QM1", action: upsert }',
    '    external_labels:\n      service: ibmmq\n      environment: lab\n',
  ]) assert.equal(countMatches(otel, needle), 1, needle);
  assert.ok(!otel.includes('${env:'), 'no compose-time placeholders: the rendering is literal');
  const prom = fileOf(lab, 'prometheus/prometheus.yml');
  assert.ok(prom.includes('  external_labels:\n    lab: mq-obs\n    environment: lab\n'));
  // the platform's own metrics (what the Observogram reference packs read) and the reference rules directory
  for (const job of ['alertmanager:9093', 'grafana:3000', 'loki:3100', 'tempo:3200']) assert.ok(prom.includes(`- targets: [ "${job}" ]`), job);
  assert.ok(prom.includes('  - /etc/prometheus/rules-reference/*.yml\n'));
  assert.ok(fileOf(lab, 'alertmanager/alertmanager.yml').includes('- matchers: [ environment = "lab", severity = SEV1 ]'));
  void expectDeviation;
});

test('prometheus.yml per environment: Grafana is scraped where the environment names one (https when it says so); Loki, Tempo and the reference rules are lab-only', () => {
  const r = fleetAll();
  const prod = fileOf(r.partitions.prod, 'prometheus/prometheus.yml'), staging = fileOf(r.partitions.staging, 'prometheus/prometheus.yml');
  assert.ok(prod.includes('  - job_name: grafana\n    static_configs:\n      - targets: [ "grafana.prod.internal" ]\n    scheme: https\n'));
  assert.ok(!staging.includes('job_name: grafana'), 'staging declares no Grafana endpoint');
  for (const text of [prod, staging]) {
    assert.ok(!text.includes('job_name: loki') && !text.includes('job_name: tempo') && !text.includes('rules-reference'), 'lab-only jobs and rules stay in the lab');
    assert.ok(text.includes('- job_name: prometheus\n') && text.includes('- job_name: alertmanager\n'));
  }
});

test('T10 templates: canary.env equals the compose &canary_env block key by key; the new files carry the lab inventory', () => {
  const lab = labRun().partitions.lab;
  const env = Object.fromEntries(fileOf(lab, 'qmgrs/QM1/canary.env').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(/=(.*)/s).slice(0, 2)));
  assert.deepEqual(env, composeCanaryEnv());
  const inv = parseYaml(fileOf(lab, 'prometheus/rules/ibmmq.inventory.yml'));
  assert.deepEqual(inv.groups[0].rules, [{ record: 'ibmmq:inventory:qmgr', expr: 'vector(1)', labels: { qmgr: 'QM1', environment: 'lab', site: 'lab', shape: 'container', vantage: 'dual' } }]);
  assert.deepEqual(JSON.parse(fileOf(lab, 'prometheus/file_sd/ibmmq-native.json')), [{ targets: ['mq:9157'], labels: { qmgr: 'QM1', environment: 'lab', site: 'lab', shape: 'container', source: 'native' } }]);
  assert.deepEqual(JSON.parse(fileOf(lab, 'prometheus/file_sd/ibmmq-exporter.json')), [{ targets: ['mq-exporter:9157'], labels: { qmgr: 'QM1', environment: 'lab', site: 'lab', shape: 'container', source: 'exporter' } }]);
  assert.deepEqual(JSON.parse(fileOf(lab, 'prometheus/file_sd/certification.json')), [{ targets: ['alert-sink:9095'], labels: { environment: 'lab' } }]);
});

// ----------------------------------------------------------------- T6 / T7 / T9: the fleet's rendered files
const fleetAll = () => runWith(fleet, 'all');

test('T6 fleet: every target, resource, external label, exporter metadata and canary attribute carries its partition environment', () => {
  const r = fleetAll();
  assert.deepEqual(r.errors, []);
  for (const [env, p] of Object.entries(r.partitions)) {
    for (const f of p.files.filter(x => x.path.startsWith('prometheus/file_sd/'))) for (const e of JSON.parse(f.content)) assert.equal(e.labels.environment, env, f.path);
    const sp = parseYaml(fileOf(p, 'packs/ibmmq.pack.yaml'));
    for (const s of sp.spec.pipelines.receivers.find(x => x.name === 'prometheus').scrape_configs) for (const e of s.static_configs) assert.equal(e.labels?.environment, env, `pack pipelines ${s.job_name}`);
    const otel = fileOf(p, 'otelcol/config.yaml');
    assert.ok(otel.includes(`{ key: deployment.environment, value: "${env}", action: upsert }`), `${env}: resource processor`);
    assert.ok(otel.includes(`    external_labels:\n      service: ibmmq\n      environment: ${env}\n`), `${env}: remote-write external labels`);
    assert.ok(!otel.includes('${env:'), `${env}: no compose-time placeholders in a fleet gateway`);
    assert.ok(fileOf(p, 'prometheus/prometheus.yml').includes(`  external_labels:\n    environment: ${env}\n`), `${env}: prometheus.yml external label`);
    for (const qm of p.manifest.queue_managers) {
      assert.ok(fileOf(p, `qmgrs/${qm.name}/mq_prometheus.yaml`).includes(`  metadataMap:\n    ENV: ${env}\n`), `${qm.name}: exporter metadataMap`);
      assert.ok(fileOf(p, `qmgrs/${qm.name}/canary.env`).includes(`deployment.environment=${env},`), `${qm.name}: canary resource attributes`);
    }
    const am = parseYaml(fileOf(p, 'alertmanager/alertmanager.yml'));
    for (const route of am.route.routes) assert.ok(route.matchers.includes(`environment = "${env}"`), `${env}: every Alertmanager route matches its environment`);
  }
});

test('T7 fleet: per-environment Alertmanager routing and the merged fleet file (distinct receivers, secrets as file references)', () => {
  const r = fleetAll();
  const prod = parseYaml(fileOf(r.partitions.prod, 'alertmanager/alertmanager.yml'));
  assert.equal(prod.route.receiver, 'mq-team');
  assert.deepEqual(prod.route.routes.map(x => [x.matchers.join(' '), x.receiver, x.group_wait ?? null]), [['environment = "prod" severity = SEV1', 'pagerduty-mq', '10s'], ['environment = "prod" severity = SEV2', 'mq-oncall', null]]);
  assert.equal(prod.route.group_wait, '30s'); assert.equal(prod.route.group_interval, '5m'); assert.equal(prod.route.repeat_interval, '4h'); assert.equal(prod.global.resolve_timeout, '1m');
  assert.deepEqual(prod.receivers.map(x => x.name), ['pagerduty-mq', 'mq-oncall', 'mq-team']);
  assert.equal(prod.receivers[0].pagerduty_configs[0].routing_key_file, '/etc/alertmanager/secrets/pagerduty_mq');
  assert.equal(prod.receivers[1].msteamsv2_configs[0].webhook_url_file, '/etc/alertmanager/secrets/msteams_mq_oncall');
  const staging = parseYaml(fileOf(r.partitions.staging, 'alertmanager/alertmanager.yml'));
  assert.deepEqual(staging.route.routes.map(x => [x.matchers.join(' '), x.receiver]), [['environment = "staging" severity = SEV1', 'mq-team']], 'one receiver for every severity: only the SEV1 route (its own group_wait)');
  const fleetFile = r.fleet.files.find(f => f.path === 'alertmanager.fleet.yml');
  assert.ok(fleetFile, 'alertmanager.fleet.yml with --env all');
  const fl = parseYaml(fleetFile.content);
  assert.equal(fl.route.receiver, 'fleet-default');
  assert.deepEqual(fl.route.routes.map(x => [x.matchers.join(' '), x.receiver]), [['environment = "prod"', 'prod-mq-team'], ['environment = "staging"', 'staging-mq-team']]);
  assert.deepEqual(fl.route.routes[0].routes.map(x => x.receiver), ['prod-pagerduty-mq', 'prod-mq-oncall']);
  const names = fl.receivers.map(x => x.name);
  assert.equal(new Set(names).size, names.length, 'receiver names are distinct');
  assert.deepEqual(names, ['fleet-default', 'prod-pagerduty-mq', 'prod-mq-oncall', 'prod-mq-team', 'staging-mq-team']);
  for (const text of [fleetFile.content, fileOf(r.partitions.prod, 'alertmanager/alertmanager.yml')]) {
    assert.ok(!/\b(routing_key|webhook_url|service_key):/.test(text), 'no secret value, only *_file references');
  }
});

test('T9 templates (vantage single): the degraded rule set, the inventory join, the promtool cases, no native scrape anywhere', () => {
  const p = fleetAll().partitions.staging;
  const alerts = fileOf(p, 'prometheus/rules/ibmmq.alerts.yml');
  assert.ok(!alerts.includes('IBMMQQueueManagerDown'));
  assert.ok(alerts.includes('- alert: IBMMQQueueManagerRestarted') && alerts.includes('runbook: runbooks/qmgr-restarted.md'));
  assert.ok(alerts.includes('expr: ibmmq_qmgr_status{job="ibmmq-exporter"} != 2\n        for: 30s'), 'Unreachable without the native gate, for: max(3 scrapes, symptom for)');
  assert.ok(alerts.includes('expr: absent_over_time(up{job="ibmmq-exporter"}[1m])'), 'pipeline alert on the exporter job');
  assert.equal(countMatches(alerts, 'sli: qmgr_process_up'), 0, 'no alert labelled with the dropped SLI');
  for (const path of ['prometheus/rules/ibmmq.alerts.yml', 'prometheus/rules/ibmmq.recording.yml', 'prometheus/rules/ibmmq.burn.yml', 'prometheus/rules/ibmmq.inventory.yml', 'otelcol/config.yaml']) {
    assert.equal(countMatches(fileOf(p, path), 'ibmmq-native'), 0, `${path}: nothing reads the native job`);
  }
  assert.equal(countMatches(fileOf(p, 'prometheus/rules/ibmmq.recording.yml'), 'qmgr_process_up'), 0);
  const inv = fileOf(p, 'prometheus/rules/ibmmq.inventory.yml');
  assert.ok(inv.includes('- alert: IBMMQQueueManagerSilent') && inv.includes('expr: ibmmq:inventory:qmgr unless on (qmgr) up{job="ibmmq-exporter"}') && inv.includes('runbook: runbooks/qmgr-silent.md'));
  assert.ok(inv.includes('labels: { qmgr: QMORDS, environment: staging, site: dc1, shape: host, vantage: single }'));
  const tests = fileOf(p, 'prometheus/tests/ibmmq.alerts.test.yml');
  for (const marker of ['# (i) single vantage', '# (ii) a status blip', '# (iii) no MQ telemetry', '# (iv) the inventory says QMORDS exists', '# (v) uptime below four scrapes', '# M22']) assert.ok(tests.includes(marker), marker);
  assert.ok(!tests.includes('# M10') && tests.includes('- ../rules/ibmmq.inventory.yml'));
  assert.ok(!p.files.some(f => f.path === 'prometheus/file_sd/ibmmq-native.json'), 'no native file_sd for a single vantage');
  const otel = fileOf(p, 'otelcol/config.yaml');
  assert.ok(otel.includes('file_sd_configs:') && otel.includes('honor_labels: true') && !otel.includes('\n  filelog:\n') && otel.includes('receivers: [ otlp ]\n      processors: [ memory_limiter, resource, transform/mqlogs, batch ]'), 'file_sd scrape, honor_labels on the exporter job, no docker filelog receiver for amqerr-json');
  const exporter = fileOf(p, 'qmgrs/QMORDS/mq_prometheus.yaml');
  assert.ok(exporter.includes('ccdtUrl: file:///etc/mq/ccdt/QMORDS.json') && !exporter.includes('connName:') && exporter.includes('passwordFile: /run/secrets/mqmon-QMORDS') && exporter.includes('port: 9161'));
  assert.ok(exporter.includes('    - "SYSTEM.DEAD.LETTER.QUEUE"\n') && !exporter.includes('"!SYSTEM.*"'), 'a SYSTEM.* DEADQ is listed and not excluded');
  const canary = fileOf(p, 'qmgrs/QMORDS/canary.env');
  assert.ok(canary.includes('MQ_CCDT_URL=file:///etc/mq/ccdt/QMORDS.json') && canary.includes('MQ_KEY_REPOSITORY=/etc/mq/tls/mqmon') && !canary.includes('ORDERS_QUEUE='));
});

// ----------------------------------------------------------------- T11 check-rules --site; site-aware boards
test('T11 check-rules --site is green on the lab partition and on every partition of the fleet example', () => {
  const out = mkdtempSync(join(tmpdir(), 'mq-site-'));
  try {
    assert.equal(cli('--inventory', 'sites/lab.inventory.yaml', '--env', 'lab', '--out', join(out, 'lab-rt')).status, 0);
    assert.equal(cli('--inventory', 'sites/fleet-example.inventory.yaml', '--env', 'all', '--out', join(out, 'fleet')).status, 0);
    for (const site of [join(out, 'lab-rt', 'lab', 'site.json'), join(out, 'fleet', 'prod', 'site.json'), join(out, 'fleet', 'staging', 'site.json')]) {
      const r = spawnSync(process.execPath, [resolve(ROOT, 'tools/check-rules.mjs'), '--site', site], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(r.status, 0, `${site}\n${r.stderr}${r.stdout}`);
      assert.match(r.stdout, /cross-checked against the pack/);
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('boards follow the site: no native job or process panels for a single vantage; delta estimator and exporter names for non-container; lab names otherwise', () => {
  const r = fleetAll();
  const staging = r.partitions.staging, prod = r.partitions.prod;
  for (const f of ['ibmmq-unified', 'ibmmq-overview', 'ibmmq-queues', 'ibmmq-slo-burn']) {
    const text = fileOf(staging, `grafana/dashboards/${f}.json`);
    assert.equal(countMatches(text, 'ibmmq-native'), 0, `${f}: nothing reads the native job`);
    assert.equal(countMatches(text, 'qmgr_process_up'), 0, `${f}: no process SLI/SLO panel`);
  }
  const unified = JSON.parse(fileOf(prod, 'grafana/dashboards/ibmmq-unified.json'));
  const exprs = unified.panels.flatMap(p => (p.targets || []).map(t => t.expr)).filter(Boolean);
  assert.ok(exprs.some(e => e.includes('sum_over_time(ibmmq_qmgr_interval_mqput_mqput1_total_count{job="ibmmq-native"}[2m]) / 120')), 'non-container: the exporter delta name and estimator on the native job');
  assert.ok(!exprs.some(e => /ibmmq_qmgr_[a-z_]+_total\{/.test(e)), 'non-container: no _total counter is read (the local exporter has none)');
  assert.ok(exprs.some(e => e.includes('ibmmq_qmgr_log_current_primary_space_in_use_percentage{job="ibmmq-native"}')) && exprs.some(e => e.includes('100 * ibmmq_qmgr_log_file_system_free_space_bytes{job="ibmmq-native"} / ibmmq_qmgr_log_file_system_max_bytes{job="ibmmq-native"}')), 'non-container: the two renamed gauges');
  assert.equal(unified.title, 'IBM MQ — Unified Observability · prod');
  assert.ok(JSON.stringify(unified).includes('over MON.SVRCONN'), 'descriptions name the site\'s monitoring channel');
  assert.ok(!JSON.stringify(unified).includes('APP.ORDERS.REQ') && !JSON.stringify(unified).includes('Orders produced'), 'no orders panels when orders_queue is null');
  const stagingUnified = JSON.parse(fileOf(staging, 'grafana/dashboards/ibmmq-unified.json'));
  const stagingExprs = stagingUnified.panels.flatMap(p => (p.targets || []).map(t => t.expr)).filter(Boolean);
  assert.ok(stagingExprs.some(e => e.includes('sum_over_time(ibmmq_qmgr_commit_count{job="ibmmq-exporter"}[2m]) / 120')), 'single vantage: the queue manager counters come from the exporter job');
  assert.ok(!stagingUnified.panels.some(p => p.title === 'Native endpoint'));
});

test('T4 templates (prod, step 30): every window, for:, damping and interval follows the timing model', () => {
  const p = fleetAll().partitions.prod;
  const alerts = fileOf(p, 'prometheus/rules/ibmmq.alerts.yml');
  assert.equal(countMatches(alerts, '\n        for: 2m\n'), 12, 'the twelve symptom alerts at alerts.symptom.for');
  assert.equal(countMatches(alerts, '[3m]'), 3, 'native gate in the comment, Unreachable and the pipeline alert');
  assert.ok(alerts.includes('keep_firing_for: 3m') && alerts.includes('[2m])) or vector(0)') && alerts.includes('[6m])) == 0') && alerts.includes('[90s])) < 15'));
  assert.ok(alerts.includes('in the last 120 s although probes continue') && alerts.includes('in 6 min (hung'));
  const rec = fileOf(p, 'prometheus/rules/ibmmq.recording.yml');
  assert.ok(rec.includes('interval: 30s') && rec.includes('[5m:30s]') && countMatches(rec, '[90s]') === 6 && rec.includes('queue!="SYSTEM.DEAD.LETTER.QUEUE"'));
  assert.ok(fileOf(p, 'grafana/provisioning/datasources/datasources.yaml').includes('timeInterval: 30s'));
  assert.ok(fileOf(p, 'prometheus/prometheus.yml').includes('scrape_interval: 30s\n  evaluation_interval: 30s'));
  const otel = fileOf(p, 'otelcol/config.yaml');
  assert.ok(otel.includes('scrape_interval: 30s\n        scrape_timeout: 8s') && otel.includes('files: [ /etc/otelcol/file_sd/ibmmq-native.json ]') && !otel.includes('key: mq.qmgr.name'));
  assert.ok(otel.includes('endpoint: https://mimir.prod.internal/api/v1/push\n    tls:\n      insecure: false'));
  for (const qm of ['QMORD1', 'QMPAY1']) {
    assert.ok(fileOf(p, `qmgrs/${qm}/mq_prometheus.yaml`).includes('pollInterval: 30s\n'), `${qm}: poll`);
    assert.ok(fileOf(p, `qmgrs/${qm}/canary.env`).includes('INTERVAL_MS=30000'), `${qm}: probe`);
  }
  assert.deepEqual(JSON.parse(fileOf(p, 'prometheus/file_sd/ibmmq-native.json')).map(e => e.targets[0]), ['10.20.5.11:9157', 'mqpay1.prod.internal:9157'], 'the RDQM floating address for the native scrape');
  assert.deepEqual(p.manifest.skipped, ['prometheus/tests/ibmmq.alerts.test.yml'], 'the lab-timed promtool cases are not rendered at a 30 s step');
});
