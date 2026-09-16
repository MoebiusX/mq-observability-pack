#!/usr/bin/env node
// Validate packs/*.pack.yaml against the vendored ObservabilityPack spec v1.2 schema
// (vendor/observogram — validator + mini-yaml lifted from MoebiusX/Observogram).
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from '../vendor/observogram/lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION } from '../vendor/observogram/lib/validator.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(resolve(root, 'vendor/observogram/observability-pack.schema.json'), 'utf8'));
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(resolve(root, 'packs')).filter(f => f.endsWith('.pack.yaml')).map(f => resolve(root, 'packs', f));

let bad = 0;
for (const f of files) {
  const errors = validateCanonical(parseYaml(readFileSync(f, 'utf8')), schema);
  if (errors.length) { bad++; console.error(`✗ ${f}`); for (const e of errors) console.error(`    ${e}`); }
  else console.log(`✓ ${f}  [spec v${SPEC_VERSION}]`);
}
process.exit(bad ? 1 : 0);
