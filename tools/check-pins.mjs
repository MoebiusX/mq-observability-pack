#!/usr/bin/env node
// Every version pin is written in several places (Compose defaults, .env.example, CI's tool
// downloads, the exporter and canary Dockerfiles, the README's versions paragraph) and every
// vendored file has a recorded upstream commit. This check fails when two places disagree and,
// with network, when a vendored copy differs from the file at its recorded commit; it warns
// when upstream `develop` has moved past that commit (staleness).
//
//   node tools/check-pins.mjs             # pins + vendored copies (fetches raw files from GitHub)
//   node tools/check-pins.mjs --offline   # pins only, no network (what `npm test` runs)
//   node tools/check-pins.mjs --strict    # staleness is an error, not a warning
//
// Exit 0 ok, 1 a pin disagrees or a vendored copy differs from its source, 2 cannot read a file.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const offline = process.argv.includes('--offline');
const strict = process.argv.includes('--strict');
const read = (p) => { try { return readFileSync(resolve(root, p), 'utf8'); } catch (e) { console.error(`✗ cannot read ${p}: ${e.message}`); process.exit(2); } };
let bad = 0, warn = 0;
const fail = (m) => { bad++; console.error(`✗ ${m}`); };
const note = (m) => { warn++; console.error(`! ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);

// ---------------------------------------------------------------- pins
const compose = read('docker-compose.yaml'), envx = read('.env.example'), ci = read('.github/workflows/ci.yml');
const expDocker = read('stack/mq-exporter/Dockerfile'), canDocker = read('canary/Dockerfile'), readme = read('README.md');
const composeDefaults = Object.fromEntries([...compose.matchAll(/\$\{([A-Z_]+_TAG):-([^}]+)\}/g)].map(m => [m[1], m[2]]));
const envDefaults = Object.fromEntries([...envx.matchAll(/^([A-Z_]+_TAG)=(\S+)/gm)].map(m => [m[1], m[2]]));
for (const [k, v] of Object.entries(envDefaults)) {
  if (!(k in composeDefaults)) fail(`.env.example ${k}=${v} has no default in docker-compose.yaml`);
  else if (composeDefaults[k] !== v) fail(`${k}: .env.example says ${v}, docker-compose.yaml default is ${composeDefaults[k]}`);
}
for (const k of Object.keys(composeDefaults)) if (!(k in envDefaults)) fail(`docker-compose.yaml default ${k}=${composeDefaults[k]} is not listed in .env.example`);
const ciEnv = Object.fromEntries([...ci.matchAll(/^\s*([A-Z_]+_VERSION):\s*(\S+)/gm)].map(m => [m[1], m[2]]));
const stripV = (s) => String(s).replace(/^v/, '');
for (const [ciKey, tagKey] of [['PROM_VERSION', 'PROM_TAG'], ['AM_VERSION', 'AM_TAG'], ['OTELCOL_VERSION', 'OTELCOL_TAG']]) {
  if (!ciEnv[ciKey]) fail(`ci.yml has no ${ciKey}`);
  else if (stripV(ciEnv[ciKey]) !== stripV(composeDefaults[tagKey])) fail(`${ciKey}=${ciEnv[ciKey]} in ci.yml but the stack runs ${tagKey}=${composeDefaults[tagKey]}: CI validates with a different tool version than the lab runs`);
}
const dockerTag = /ARG MQ_METRIC_SAMPLES_TAG=(\S+)/.exec(expDocker)?.[1];
const composeArg = /MQ_METRIC_SAMPLES_TAG:\s*(\S+)/.exec(compose)?.[1];
const composeImage = /image:\s*mq-obs\/mq_prometheus:(\S+)/.exec(compose)?.[1];
if (dockerTag !== composeArg || dockerTag !== composeImage) fail(`mq_prometheus tag: Dockerfile ${dockerTag}, compose build arg ${composeArg}, compose image ${composeImage}`);
const vrmf = /VRMF=(\d+\.\d+\.\d+)\.\d+/.exec(expDocker)?.[1];
const mqijs = /MQIJS_VRM=(\d+\.\d+\.\d+)/.exec(canDocker)?.[1];
if (vrmf !== mqijs) fail(`MQ client level: exporter VRMF ${vrmf}, canary MQIJS_VRM ${mqijs} (both clients should be the same level)`);
const readmeMust = [
  [`mq-metric-samples@${dockerTag}`, 'exporter source tag'], [`otelcol-contrib ${composeDefaults.OTELCOL_TAG}`, 'collector'],
  [`Prometheus ${stripV(composeDefaults.PROM_TAG).replace(/\.\d+$/, '')}`, 'Prometheus'], [`Alertmanager\n${stripV(composeDefaults.AM_TAG).replace(/\.\d+$/, '')}`, 'Alertmanager'],
  [`Loki ${composeDefaults.LOKI_TAG}`, 'Loki'], [`Tempo ${composeDefaults.TEMPO_TAG}`, 'Tempo'], [`Grafana ${composeDefaults.GRAFANA_TAG}`, 'Grafana'], [`mq:${composeDefaults.MQ_IMAGE_TAG}`, 'MQ image'],
];
for (const [needle, what] of readmeMust) if (!readme.replace(/\s+/g, ' ').includes(needle.replace(/\s+/g, ' '))) fail(`README versions paragraph does not mention ${what} as "${needle.replace(/\s+/g, ' ')}"`);
if (!bad) ok(`pins agree: compose, .env.example, ci.yml, Dockerfiles and README (${Object.keys(composeDefaults).length} image tags, exporter ${dockerTag}, MQ client ${vrmf})`);

// ---------------------------------------------------------------- vendored copies
const sources = JSON.parse(read('vendor/observogram/SOURCES.json'));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
for (const [local, s] of Object.entries(sources.files)) {
  const text = readFileSync(resolve(root, 'vendor/observogram', local));
  if (s.sha256 && sha(text) !== s.sha256) fail(`vendor/observogram/${local}: content differs from the recorded sha256 (edited locally? refresh by copying from ${s.repo}@${s.commit} ${s.path})`);
}
if (!bad) ok(`${Object.keys(sources.files).length} vendored files match their recorded content hashes`);
if (offline) { console.log(bad ? `${bad} problem(s)` : 'ok (offline: upstream not checked)'); process.exit(bad ? 1 : 0); }
const raw = async (repo, ref, path) => { const r = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${path}`); if (!r.ok) throw new Error(`HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
let stale = 0;
for (const [local, s] of Object.entries(sources.files)) {
  const text = readFileSync(resolve(root, 'vendor/observogram', local));
  try {
    const pinned = await raw(s.repo, s.commit, s.path);
    if (sha(pinned) !== sha(text)) fail(`vendor/observogram/${local} differs from ${s.repo}@${s.commit}:${s.path}`);
    const head = await raw(s.repo, s.track || 'develop', s.path);
    if (sha(head) !== sha(text)) { stale++; (strict ? fail : note)(`vendor/observogram/${local}: ${s.repo} ${s.track || 'develop'} has moved past ${s.commit} for ${s.path} (refresh when the change is wanted)`); }
  } catch (e) { note(`vendor/observogram/${local}: could not fetch upstream (${e.message}); run with --offline to skip`); }
}
if (!stale && !warn) ok('vendored files equal their recorded upstream commit and upstream has not moved');
console.log(bad ? `${bad} problem(s)` : warn ? `ok with ${warn} warning(s)` : 'ok');
process.exit(bad ? 1 : 0);
