#!/usr/bin/env node
// Generates stack/grafana/dashboards/*.json for the pack, with Observogram's dashboard library
// (vendor/observogram/lib/dashboards/, copied from Observogram, never edited here) and the
// MQ-specific board definitions in tools/dashboards/ibmmq.mjs. Pack bindings live in each
// panel's `pack.binds_to` array (tools/check-rules.mjs reads it); every `panel_bindings[]`
// entry of the pack must be bound by a panel or nothing is written.
//
//   node tools/gen-dashboards.mjs                       # packs/ibmmq.pack.yaml
//   node tools/gen-dashboards.mjs --site sites/prod/site.json   # a gen-site partition: its pack and repo_url
//   node tools/gen-dashboards.mjs --repo-url https://github.com/me/fork/blob/main
//   PACK=packs/ibmmq-site.pack.yaml node tools/gen-dashboards.mjs
//
// Runbook links on the boards point at a repository: --repo-url, else the site's repo_url, else
// REPO_URL, else this package.json's repository. Output files are the basenames of the pack's
// `dashboards[].source` entries, written into the directory the first source names
// (stack/grafana/dashboards for the lab pack) unless --out-dir says otherwise.
//
// generateDashboards(pack, { repoUrl, site }) is the body of the CLI as a function
// (tools/site/ibmmq.mjs imports it); the CLI runs only when this file is the entry point.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from '../vendor/observogram/lib/mini-yaml.mjs';
import * as lib from '../vendor/observogram/lib/dashboards/lib.mjs';
import { checkBindings } from '../vendor/observogram/lib/dashboards/generic.mjs';
import { boards } from './dashboards/ibmmq.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Runbook link base: --repo-url > site.repo_url > REPO_URL > package.json repository. */
export function defaultRepoUrl({ repoUrl = null, site = null } = {}) {
  if (repoUrl) return repoUrl;
  if (site?.repo_url) return site.repo_url;
  if (process.env.REPO_URL) return process.env.REPO_URL;
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  return `https://github.com/${String(pkg.repository || '').replace(/^github:/, '')}/blob/main`;
}

/**
 * generateDashboards(pack, { repoUrl, site }) → { boards: [{ id, file, dashboard }], problems, repoUrl }.
 * `site` is a gen-site manifest (or the module's dashboardOptions) handed to boards(); absent
 * means the lab. `problems` are checkBindings' findings: a non-empty list means do not write.
 */
export function generateDashboards(pack, { repoUrl = null, site = null } = {}) {
  const url = defaultRepoUrl({ repoUrl, site });
  const out = boards({ pack, lib, repoUrl: url, site });
  return { boards: out, problems: checkBindings(pack, out), repoUrl: url };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const sitePath = opt('--site');
  const site = sitePath ? JSON.parse(readFileSync(resolve(root, sitePath), 'utf8')) : null;
  const packPath = opt('--pack') || process.env.PACK || (site?.pack?.file ? resolve(dirname(resolve(root, sitePath)), site.pack.file) : 'packs/ibmmq.pack.yaml');
  const pack = parseYaml(readFileSync(resolve(root, packPath), 'utf8'));
  const firstSource = (pack.spec.dashboards || []).find(d => d.source)?.source || 'file://stack/grafana/dashboards/x.json';
  const outDir = resolve(root, opt('--out-dir') || dirname(firstSource.replace(/^file:\/\//, '')));

  const { boards: out, problems } = generateDashboards(pack, { repoUrl: opt('--repo-url'), site });
  if (problems.length) { for (const p of problems) console.error(`✗ ${p}`); process.exit(1); }
  mkdirSync(outDir, { recursive: true });
  for (const b of out) writeFileSync(resolve(outDir, b.file), JSON.stringify(b.dashboard, null, 2) + '\n');
  console.log('dashboards written');
}
