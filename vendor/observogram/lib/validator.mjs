// tools/lib/validator.mjs
//
// Shared JSON Schema 2020-12 walker (subset) + ObservabilityPack v1.2
// gatekeeper. Used by tools/validate-pack.mjs (CLI) and server/index.mjs
// (POST /api/validate, GET /api/packs/:id). Pure ESM — no Node APIs — so a
// future browser-side validation path can import the same module.
//
// Supported keywords:
//   type, enum, const, pattern, minLength, maxLength,
//   minimum, maximum, exclusiveMinimum, exclusiveMaximum,
//   minItems, maxItems, contains, items,
//   required, properties, patternProperties, additionalProperties,
//   propertyNames, minProperties, maxProperties,
//   allOf, oneOf, anyOf, not, if/then/else,
//   $ref (local $defs only), format (uri | date-time).

export const REQUIRED_API_VERSION = 'observability.platform/v1';
export const REQUIRED_KIND = 'ObservabilityPack';
export const SPEC_VERSION = '1.2';

const URI_RE       = /^[a-z][a-z0-9+.-]*:\S+$/i;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchType(expected, actual, value) {
  if (expected === actual) return true;
  if (expected === 'integer' && actual === 'number' && Number.isInteger(value)) return true;
  if (expected === 'number'  && actual === 'number') return true;
  return false;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/$defs/')) throw new Error(`unsupported $ref: ${ref}`);
  const name = ref.slice('#/$defs/'.length);
  const t = root.$defs?.[name];
  if (!t) throw new Error(`unresolved $ref: ${ref}`);
  return t;
}

export function validate(value, schema, path, errors, root) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.$ref) schema = resolveRef(schema.$ref, root);

  if (schema.type !== undefined) {
    const t = typeOf(value);
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(e => matchType(e, t, value))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${t}`);
      return; // type mismatch — skip the rest (everything else would compound)
    }
  }

  if ('const' in schema && !deepEqual(value, schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum && !schema.enum.some(e => deepEqual(e, value))) {
    errors.push(`${path}: not in enum ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }

  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match pattern /${schema.pattern}/`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: length ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: length ${value.length} > maxLength ${schema.maxLength}`);
    }
    if (schema.format === 'uri'       && !URI_RE.test(value))       errors.push(`${path}: not a valid uri`);
    if (schema.format === 'date-time' && !DATE_TIME_RE.test(value)) errors.push(`${path}: not a valid date-time`);
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${path}: ${value} >= exclusiveMaximum ${schema.exclusiveMaximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: ${value.length} items < minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: ${value.length} items > maxItems ${schema.maxItems}`);
    if (schema.items) value.forEach((v, i) => validate(v, schema.items, `${path}[${i}]`, errors, root));
    if (schema.contains) {
      const ok = value.some((v, i) => { const s = []; validate(v, schema.contains, `${path}[${i}]`, s, root); return s.length === 0; });
      if (!ok) errors.push(`${path}: contains schema not satisfied by any item`);
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (schema.required) for (const k of schema.required) if (!(k in value)) errors.push(`${path}: missing required key '${k}'`);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${path}: ${keys.length} props < minProperties ${schema.minProperties}`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(`${path}: ${keys.length} props > maxProperties ${schema.maxProperties}`);
    if (schema.propertyNames) for (const k of keys) validate(k, schema.propertyNames, `${path}.(propertyName ${JSON.stringify(k)})`, errors, root);
    const props = schema.properties || {};
    const patternProps = schema.patternProperties;
    const addProps = schema.additionalProperties;
    for (const k of keys) {
      let matched = false;
      const cp = `${path}.${k}`;
      if (props[k]) { validate(value[k], props[k], cp, errors, root); matched = true; }
      if (patternProps) for (const [pat, sub] of Object.entries(patternProps)) if (new RegExp(pat).test(k)) { validate(value[k], sub, cp, errors, root); matched = true; }
      if (!matched) {
        if (addProps === false) errors.push(`${path}: unknown property '${k}'`);
        else if (addProps && typeof addProps === 'object') validate(value[k], addProps, cp, errors, root);
      }
    }
  }

  if (schema.allOf) for (const sub of schema.allOf) validate(value, sub, path, errors, root);
  if (schema.oneOf) {
    let passes = 0;
    for (const sub of schema.oneOf) { const s = []; validate(value, sub, path, s, root); if (s.length === 0) passes++; }
    if (passes === 0) errors.push(`${path}: matches none of oneOf branches`);
    else if (passes > 1) errors.push(`${path}: matches ${passes} oneOf branches (expected 1)`);
  }
  if (schema.anyOf && !schema.anyOf.some(sub => { const s = []; validate(value, sub, path, s, root); return s.length === 0; })) {
    errors.push(`${path}: matches none of anyOf branches`);
  }
  if (schema.not) { const s = []; validate(value, schema.not, path, s, root); if (s.length === 0) errors.push(`${path}: matches forbidden 'not' schema`); }
  if (schema.if) {
    const s = []; validate(value, schema.if, path, s, root);
    if (s.length === 0 && schema.then) validate(value, schema.then, path, errors, root);
    else if (s.length > 0 && schema.else) validate(value, schema.else, path, errors, root);
  }
}

// Returns null if `pack` looks like a canonical v1.2 manifest, or an error
// message string otherwise. Cheap pre-check before running the full walker.
export function gatekeep(pack) {
  if (pack?.apiVersion !== REQUIRED_API_VERSION || pack?.kind !== REQUIRED_KIND) {
    return (
      `not a canonical ObservabilityPack v${SPEC_VERSION} manifest. ` +
      `Expected apiVersion: ${REQUIRED_API_VERSION}, kind: ${REQUIRED_KIND}. ` +
      `Got apiVersion: ${JSON.stringify(pack?.apiVersion)}, kind: ${JSON.stringify(pack?.kind)}. ` +
      `See vendor/observability-pack-spec/v${SPEC_VERSION}/spec.md for the canonical shape. ` +
      `Previous-format (layered JSON) packs upconvert with \`npm run upconvert-legacy <file>\` ` +
      `— or just upload them in the studio, which converts them automatically (see examples/legacy/).`
    );
  }
  return null;
}

// Convenience: gatekeep + full walker. Returns an array of error strings.
export function validateCanonical(pack, schema) {
  const gate = gatekeep(pack);
  if (gate) return [gate];
  const errors = [];
  validate(pack, schema, '$', errors, schema);
  return errors;
}
