// tools/lib/site/derive.mjs
//
// Site-pack derivation (gen-site design §6): the reference pack is rewritten as TEXT, never
// re-serialised, so comments and layout survive and the lab site pack is byte-identical to the
// reference. Every substitution is an exact-count anchor: `{ name, find, replace, count }`; when
// `find` matches a different number of times than declared the derivation fails naming the
// anchor, so a hand edit that breaks an anchor is caught, never skipped. Pure ESM, browser-safe.
//
//   assertCounts(text, subs)                       throws naming the first mismatching anchor
//   applySubstitutions(text, subs)                 → { text, applied }
//   dropItem(text, key, value)                     deletes every YAML list item `- key: value` (block
//                                                  or flow form) through the end of that item
//   splicePackSnippet(text, snippet, startMarker)  replaces the generated block between the marker
//                                                  line and the end of the recording_rules list
//   derivePack(refText, subs, removals, opts)      → { text, pack, applied, errors }

import { parse as parseYaml } from '../mini-yaml.mjs';
import { validateCanonical } from '../validator.mjs';

/** The comment that opens the generated block of spec.queries.recording_rules (`# --- error-budget rules, GENERATED …`). */
export const GENERATED_MARKER = 'error-budget rules, GENERATED';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isRe = (v) => v instanceof RegExp;
const globalRe = (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
const indentOf = (line) => /^\s*/.exec(line)[0].length;
const blank = (line) => line.trim() === '';
const comment = (line) => line.trim().startsWith('#');

/** Number of occurrences of `find` (string: literal; RegExp: global matches) in text. */
export function countMatches(text, find) {
  if (isRe(find)) return (text.match(globalRe(find)) || []).length;
  if (typeof find !== 'string' || find === '') throw new Error('countMatches: find must be a non-empty string or a RegExp');
  return text.split(find).length - 1;
}

const anchorName = (s, i) => s.name || (isRe(s.find) ? String(s.find) : JSON.stringify(s.find)) || `substitution[${i}]`;

/** Throws `anchor <name>: expected N occurrences, found M` for the first mismatch; returns the counts otherwise. */
export function assertCounts(text, subs) {
  const counts = [];
  (subs || []).forEach((s, i) => {
    const name = anchorName(s, i);
    if (!Number.isInteger(s.count) || s.count < 0) throw new Error(`anchor ${name}: count must be a non-negative integer (got ${JSON.stringify(s.count)})`);
    const found = countMatches(text, s.find);
    if (found !== s.count) throw new Error(`anchor ${name}: expected ${s.count} occurrence${s.count === 1 ? '' : 's'}, found ${found}`);
    counts.push({ name, count: found });
  });
  return counts;
}

/** Apply exact-count substitutions in order (each anchor is asserted against the text it sees). */
export function applySubstitutions(text, subs) {
  const applied = [];
  let out = text;
  (subs || []).forEach((s, i) => {
    const name = anchorName(s, i);
    assertCounts(out, [s]);
    const before = out;
    if (isRe(s.find)) out = out.replace(globalRe(s.find), s.replace);
    else out = out.split(s.find).join(typeof s.replace === 'function' ? s.replace(s.find) : String(s.replace));
    applied.push({ name, count: s.count, changed: out !== before });
  });
  return { text: out, applied };
}

/**
 * Index range [start, end) of the list item that begins at line `start` (a `- ` line at indent
 * n): every following line that is blank, or indented deeper than n, or a flow continuation,
 * until the next `- ` at indent n or a dedent. Trailing blank lines are left out.
 */
function itemEnd(lines, start) {
  const n = indentOf(lines[start]);
  let i = start + 1;
  let depth = braceDepth(lines[start]);
  while (i < lines.length) {
    const l = lines[i];
    if (depth > 0) { depth += braceDepth(l); i++; continue; }
    if (blank(l)) { i++; continue; }
    if (indentOf(l) <= n) break;   // next sibling `- `, a comment introducing it, or a dedent
    i++;
  }
  while (i > start + 1 && blank(lines[i - 1])) i--;
  return i;
}
function braceDepth(line) {
  let d = 0, inS = false, inD = false;
  const code = line.replace(/\s#.*$/, '');
  for (const ch of code) {
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (!inS && !inD) { if (ch === '{' || ch === '[') d++; else if (ch === '}' || ch === ']') d--; }
  }
  return d;
}

/**
 * Delete every list item whose mapping has `key: value` at its head — block form
 * (`- id: qmgr_process_up` and the indented lines below it) or flow form
 * (`- { panel: x, binds_to: slos.qmgr_process_up_99_9 }`, the key anywhere in the braces).
 * Throws when nothing matches (a removal that finds nothing is drift).
 */
export function dropItem(text, key, value) {
  const lines = text.split('\n');
  const block = new RegExp(`^\\s*- ${esc(key)}:\\s*${esc(value)}\\s*(#.*)?$`);
  const flow = new RegExp(`^\\s*- \\{.*\\b${esc(key)}:\\s*${esc(value)}\\s*[,}]`);
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!(block.test(l) || flow.test(l))) continue;
    const end = itemEnd(lines, i);
    lines.splice(i, end - i);
    // collapse the double blank line the deletion may have left
    if (i > 0 && i < lines.length && blank(lines[i - 1]) && blank(lines[i])) lines.splice(i, 1);
    removed++;
    i--;
  }
  if (!removed) throw new Error(`dropItem: no list item with ${key}: ${value}`);
  return lines.join('\n');
}

/**
 * Replace the generated block of `spec.queries.recording_rules`: everything from the first list
 * item after the marker line (comment lines directly under the marker are kept as part of the
 * header) to the end of the list (the last line indented at least as deep as that item) becomes
 * `snippet`, re-indented to the list's indentation.
 */
export function splicePackSnippet(text, snippet, startMarker = GENERATED_MARKER) {
  const lines = text.split('\n');
  const mi = lines.findIndex(l => comment(l) && l.includes(startMarker));
  if (mi < 0) throw new Error(`splicePackSnippet: no comment line containing ${JSON.stringify(startMarker)}`);
  let first = mi + 1;
  while (first < lines.length && (comment(lines[first]) || blank(lines[first]))) first++;
  const markerIndent = indentOf(lines[mi]);
  let itemIndent;
  let end;
  if (first < lines.length && /^\s*- /.test(lines[first]) && indentOf(lines[first]) >= markerIndent) {
    itemIndent = indentOf(lines[first]);
    end = first;
    while (end < lines.length && (blank(lines[end]) || indentOf(lines[end]) >= itemIndent)) end++;
    while (end > first && blank(lines[end - 1])) end--;
  } else {
    // empty generated block: insert right after the marker's comment lines
    itemIndent = markerIndent;
    first = mi + 1;
    while (first < lines.length && comment(lines[first]) && indentOf(lines[first]) === markerIndent) first++;
    end = first;
  }
  const snip = String(snippet).replace(/\s+$/, '').split('\n');
  const snipIndent = snip.length && snip[0].trim() ? indentOf(snip[0]) : 0;
  const re = snip.map(l => (blank(l) ? '' : ' '.repeat(itemIndent) + l.slice(Math.min(snipIndent, indentOf(l)))));
  lines.splice(first, end - first, ...re);
  return lines.join('\n');
}

/**
 * derivePack(refText, substitutions, removals, { schema, snippet, startMarker }) →
 * { text, pack, applied, removed, errors }. Substitutions first, then removals
 * (`{ key, value }`), then the optional recording-rules snippet splice; the result is parsed with
 * mini-yaml and, when a schema is given, validated with validateCanonical. Errors (anchor
 * mismatch, a removal that finds nothing, parse or schema failures) are returned, not thrown,
 * and leave `text`/`pack` null.
 */
export function derivePack(refText, substitutions = [], removals = [], { schema = null, snippet = null, startMarker = GENERATED_MARKER } = {}) {
  const errors = [];
  let text, applied = [], removed = [];
  try {
    ({ text, applied } = applySubstitutions(refText, substitutions));
    for (const r of removals || []) { text = dropItem(text, r.key, r.value); removed.push(`${r.key}: ${r.value}`); }
    if (snippet != null) text = splicePackSnippet(text, snippet, startMarker);
  } catch (e) {
    return { text: null, pack: null, applied, removed, errors: [String(e.message || e)] };
  }
  let pack = null;
  try { pack = parseYaml(text); } catch (e) { errors.push(`derived pack does not parse: ${e.message || e}`); }
  if (pack && schema) for (const e of validateCanonical(pack, schema)) errors.push(`derived pack: ${e}`);
  return { text: errors.length ? null : text, pack: errors.length ? null : pack, applied, removed, errors };
}
