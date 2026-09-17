#!/usr/bin/env node
// Generates stack/grafana/dashboards/*.json for the pack, with Observogram's dashboard library
// (vendor/observogram/lib/dashboards/, copied from Observogram, never edited here) and the
// MQ-specific board definitions in tools/dashboards/ibmmq.mjs. Pack bindings live in each
// panel's `pack.binds_to` array (tools/check-rules.mjs reads it); every `panel_bindings[]`
// entry of the pack must be bound by a panel or nothing is written.
//
//   node tools/gen-dashboards.mjs                       # packs/ibmmq.pack.yaml
//   PACK=packs/ibmmq-site.pack.yaml node tools/gen-dashboards.mjs
//
// Output files are the basenames of the pack's `dashboards[].source` entries, written into the
// directory the first source names (stack/grafana/dashboards for the lab pack).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from '../vendor/observogram/lib/mini-yaml.mjs';
import * as lib from '../vendor/observogram/lib/dashboards/lib.mjs';
import { checkBindings } from '../vendor/observogram/lib/dashboards/generic.mjs';
import { boards } from './dashboards/ibmmq.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const packPath = opt('--pack') || process.env.PACK || 'packs/ibmmq.pack.yaml';
const pack = parseYaml(readFileSync(resolve(root, packPath), 'utf8'));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const repoUrl = `https://github.com/${String(pkg.repository || '').replace(/^github:/, '')}/blob/main`;
const firstSource = (pack.spec.dashboards || []).find(d => d.source)?.source || 'file://stack/grafana/dashboards/x.json';
const outDir = resolve(root, opt('--out-dir') || dirname(firstSource.replace(/^file:\/\//, '')));

const out = boards({ pack, lib, repoUrl });
const problems = checkBindings(pack, out);
if (problems.length) { for (const p of problems) console.error(`✗ ${p}`); process.exit(1); }
mkdirSync(outDir, { recursive: true });
for (const b of out) writeFileSync(resolve(outDir, b.file), JSON.stringify(b.dashboard, null, 2) + '\n');
console.log('dashboards written');
