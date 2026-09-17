// One-off helper (kept for refreshes): rebuild SOURCES.json from the current vendored files and the
// upstream commits given on the command line as local=commit pairs. Content hashes are computed here.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url));
const map = { 'lib/validator.mjs': 'tools/lib/validator.mjs', 'lib/mini-yaml.mjs': 'tools/lib/mini-yaml.mjs', 'observability-pack.schema.json': 'vendor/observability-pack-spec/v1.2/observability-pack.schema.json', 'lib/dashboards/lib.mjs': 'tools/lib/dashboards/lib.mjs', 'lib/dashboards/generic.mjs': 'tools/lib/dashboards/generic.mjs', 'lib/burn-rules.mjs': 'tools/lib/burn-rules.mjs' };
const commits = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const prev = (() => { try { return JSON.parse(readFileSync(resolve(dir, 'SOURCES.json'), 'utf8')).files; } catch { return {}; } })();
const files = {};
for (const [local, path] of Object.entries(map)) {
  const buf = readFileSync(resolve(dir, local));
  files[local] = { repo: 'MoebiusX/Observogram', path, commit: commits[local] || prev[local]?.commit || 'UNKNOWN', track: 'develop', sha256: createHash('sha256').update(buf).digest('hex') };
}
writeFileSync(resolve(dir, 'SOURCES.json'), JSON.stringify({ note: 'Recorded upstream of every vendored file. tools/check-pins.mjs verifies content against the commit and warns when develop moved. Refresh: copy the file, then node vendor/observogram/gen-sources.mjs <local>=<commit>.', files }, null, 2) + '\n');
console.log(Object.entries(files).map(([l, f]) => `${l} @ ${f.commit}`).join('\n'));
