// tools/lib/mini-yaml.mjs
//
// A minimal YAML reader sized for the ObservabilityPack canonical example
// pack. Browser-friendly (pure ES module, no Node APIs). Used by the Node
// validator and by the studio's adapter when it lands.
//
// SUPPORTED
//   - Block mappings: `key: value` and `key:` (nested block follows)
//   - Block sequences: `- item`, `- key: value` (compact sequence-of-mappings),
//     including items whose first key carries a nested block (`- key:` then
//     an indented mapping/sequence below)
//   - Flow mappings: `{k: v, k2: v2}`
//   - Flow sequences: `[a, b, c]`
//   - Literal block scalars: `|` (preserves newlines, strips common indent)
//   - Folded block scalars: `>` (folds paragraphs, strips common indent)
//   - Single- and double-quoted scalars
//   - Bare scalars: integers, floats, booleans, null, plain strings
//   - Full-line comments (`# ...`) and trailing comments
//   - Multi-document streams (`---`/`...`) via parseAll(); parse() returns
//     the first content-bearing document and tolerates a leading `---`
//
// INTENTIONAL NON-GOALS (not used in canonical packs we care about)
//   - YAML anchors / aliases (& / *)
//   - Block chomping indicators (`|+`, `|-`)
//   - Tag handles (`!!str`)
//   - Complex keys (`? key`)
//
// If a canonical pack uses something outside this subset, parse throws and
// the caller surfaces the line number.

export function parse(text) {
  const docs = parseAll(text);
  // Canonical packs are single-document. Return the first document that
  // carries content; tolerate (and skip past) leading `---` markers and
  // empty leading documents.
  for (const doc of docs) {
    if (doc !== null && doc !== undefined) return doc;
  }
  return docs.length ? docs[docs.length - 1] : null;
}

// Parse a (possibly multi-document) YAML stream into an array of documents.
// Documents are separated by a `---` line and optionally terminated by a
// `...` line, both at column 0 (indented `---`/`...` belong to scalars or
// values and are left untouched). Single-document input yields a one-element
// array, so callers that only care about the first document can use parse().
export function parseAll(text) {
  if (typeof text !== 'string') throw new Error('mini-yaml: input must be a string');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // strip BOM
  text = text.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  // Split into documents on bare `---` / `...` markers at column 0.
  const docs = [];
  let current = [];
  const hasContent = ls => ls.some(l => { const t = l.trim(); return t !== '' && !t.startsWith('#'); });
  for (const line of lines) {
    if (/^---(?:\s.*)?$/.test(line) || line === '---') {
      if (hasContent(current)) docs.push(current);
      current = [];
      continue;
    }
    if (/^\.\.\.(?:\s.*)?$/.test(line) || line === '...') {
      if (hasContent(current)) docs.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (hasContent(current)) docs.push(current);

  if (docs.length === 0) return [null];
  return docs.map(docLines => parseAtIndent(new TokenStream(docLines), 0));
}

class TokenStream {
  constructor(lines) { this.lines = lines; this.idx = 0; }
  hasMore() { return this.idx < this.lines.length; }
  // Index of the next significant (non-blank, non-comment) line. -1 at EOF.
  // Does NOT consume.
  nextSignificantIdx() {
    let i = this.idx;
    while (i < this.lines.length) {
      const tr = this.lines[i].replace(/^\s+/, '');
      if (tr !== '' && !tr.startsWith('#')) return i;
      i++;
    }
    return -1;
  }
}

function indentOf(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

// Strip a trailing `#` comment, respecting quotes and flow brackets so `#`
// inside strings is preserved. A `#` is only a comment if preceded by
// whitespace (or sits at column 0 with respect to content).
function stripTrailingComment(s) {
  let inSingle = false, inDouble = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) {
      if (c === "'" && s[i + 1] === "'") { i++; continue; }
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '\\' && i + 1 < s.length) { i++; continue; }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (c === '#' && depth === 0 && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).replace(/\s+$/, '');
    }
  }
  return s.replace(/\s+$/, '');
}

// Find the first ":" that signals a mapping (followed by space, end of line,
// or end of string), outside quotes and flow brackets. Returns -1 if none.
function findMappingColon(s) {
  let inSingle = false, inDouble = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (inDouble) {
      if (c === '\\' && i + 1 < s.length) { i++; continue; }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (c === ':' && depth === 0) {
      if (i + 1 >= s.length || s[i + 1] === ' ' || s[i + 1] === '\t') return i;
    }
  }
  return -1;
}

function looksLikeMappingHead(s) {
  // A compact sequence item like `- key: value` looks like a mapping.
  // But `- { ... }` or `- [ ... ]` is a flow value, not a mapping head.
  if (s.startsWith('{') || s.startsWith('[')) return false;
  return findMappingColon(s) !== -1;
}

function parseAtIndent(stream, minIndent) {
  const sig = stream.nextSignificantIdx();
  if (sig === -1) return null;
  const line = stream.lines[sig];
  const ind = indentOf(line);
  if (ind < minIndent) return null;
  stream.idx = sig;
  const content = stripTrailingComment(line.slice(ind));
  if (content.startsWith('- ') || content === '-') {
    return parseBlockSequence(stream, ind);
  }
  return parseBlockMapping(stream, ind);
}

function parseBlockMapping(stream, indent) {
  const out = {};
  while (true) {
    const sig = stream.nextSignificantIdx();
    if (sig === -1) break;
    const line = stream.lines[sig];
    const lineInd = indentOf(line);
    if (lineInd < indent) break;
    if (lineInd > indent) break;        // belongs to a nested node we don't own
    const content = stripTrailingComment(line.slice(indent));
    if (content.startsWith('- ') || content === '-') break;

    const colon = findMappingColon(content);
    if (colon === -1) {
      throw new Error(`yaml line ${sig + 1}: expected "key: value", got ${JSON.stringify(content)}`);
    }
    const key = unquote(content.slice(0, colon).trim());
    const rest = content.slice(colon + 1).trim();
    stream.idx = sig + 1;

    if (rest === '') {
      // nested mapping/sequence at greater indent, OR a compact sequence
      // whose items sit at the same indent as the parent mapping key (YAML
      // allows both styles).
      const nextSig = stream.nextSignificantIdx();
      if (nextSig === -1) {
        out[key] = null;
      } else {
        const childIndent = indentOf(stream.lines[nextSig]);
        const childContent = stripTrailingComment(stream.lines[nextSig].slice(childIndent));
        const isSeqItem = childContent.startsWith('- ') || childContent === '-';
        if (childIndent > indent) {
          if (isSeqItem) out[key] = parseBlockSequence(stream, childIndent);
          else out[key] = parseBlockMapping(stream, childIndent);
        } else if (childIndent === indent && isSeqItem) {
          // compact sequence: `owners:\n  - team-x\n  - team-y` where the
          // sequence items share the parent's indent.
          out[key] = parseBlockSequence(stream, childIndent);
        } else {
          out[key] = null;
        }
      }
    } else if (isBlockScalarHead(rest)) {
      out[key] = readBlockScalar(stream, indent, rest[0]);
    } else {
      out[key] = parseValue(rest);
    }
  }
  return out;
}

function parseBlockSequence(stream, indent) {
  const arr = [];
  while (true) {
    const sig = stream.nextSignificantIdx();
    if (sig === -1) break;
    const line = stream.lines[sig];
    const lineInd = indentOf(line);
    if (lineInd < indent) break;
    if (lineInd > indent) break;
    const content = stripTrailingComment(line.slice(indent));
    if (!(content.startsWith('- ') || content === '-')) break;
    stream.idx = sig + 1;
    const inline = content === '-' ? '' : content.slice(2);

    if (inline === '') {
      const ns = stream.nextSignificantIdx();
      if (ns === -1 || indentOf(stream.lines[ns]) <= indent) {
        arr.push(null);
      } else {
        const childIndent = indentOf(stream.lines[ns]);
        const childContent = stripTrailingComment(stream.lines[ns].slice(childIndent));
        if (childContent.startsWith('- ') || childContent === '-') {
          arr.push(parseBlockSequence(stream, childIndent));
        } else {
          arr.push(parseBlockMapping(stream, childIndent));
        }
      }
    } else if (isBlockScalarHead(inline)) {
      arr.push(readBlockScalar(stream, indent, inline[0]));
    } else if (looksLikeMappingHead(inline)) {
      // Compact sequence-of-mappings: first key inline, rest of the mapping
      // at indent + 2 (YAML standard: continuation indents past `- `).
      const item = {};
      const itemIndent = indent + 2;          // column where this item's keys sit
      const firstColon = findMappingColon(inline);
      const firstKey = unquote(inline.slice(0, firstColon).trim());
      const firstRest = inline.slice(firstColon + 1).trim();
      if (isBlockScalarHead(firstRest)) {
        // `- key: |` / `- key: >` — block scalar value below itemIndent.
        item[firstKey] = readBlockScalar(stream, itemIndent, firstRest[0]);
      } else if (firstRest === '') {
        // `- key:` — the first key carries a nested block (mapping/sequence)
        // at a deeper indent, e.g.
        //     - match:
        //         severity: critical
        //       receiver: pager
        const ns = stream.nextSignificantIdx();
        if (ns !== -1) {
          const childIndent = indentOf(stream.lines[ns]);
          const childContent = stripTrailingComment(stream.lines[ns].slice(childIndent));
          const isSeqItem = childContent.startsWith('- ') || childContent === '-';
          if (childIndent > itemIndent) {
            item[firstKey] = isSeqItem
              ? parseBlockSequence(stream, childIndent)
              : parseBlockMapping(stream, childIndent);
          } else if (childIndent === itemIndent && isSeqItem) {
            // compact sequence whose items share the key's indent
            item[firstKey] = parseBlockSequence(stream, itemIndent);
          } else {
            item[firstKey] = null;
          }
        } else {
          item[firstKey] = null;
        }
      } else {
        item[firstKey] = parseValue(firstRest);
      }
      // Then continue reading the rest of THIS item's mapping at itemIndent.
      const cont = parseBlockMapping(stream, itemIndent);
      Object.assign(item, cont);
      arr.push(item);
    } else {
      arr.push(parseValue(inline));
    }
  }
  return arr;
}

function isBlockScalarHead(s) {
  return /^[|>][-+]?/.test(s);
}

// Collect lines strictly more indented than `parentIndent`, preserving their
// content with the leading common indent stripped. Trailing blank lines are
// dropped; callers decide whether to preserve or fold line breaks.
function readBlockScalarLines(stream, parentIndent) {
  const collected = [];
  let blockIndent = null;
  while (stream.hasMore()) {
    const line = stream.lines[stream.idx];
    const isBlank = line.replace(/^\s+/, '') === '';
    if (isBlank) {
      collected.push('');
      stream.idx++;
      continue;
    }
    const ind = indentOf(line);
    if (ind <= parentIndent) break;
    if (blockIndent === null) blockIndent = ind;
    collected.push(line.slice(blockIndent));
    stream.idx++;
  }
  while (collected.length && collected[collected.length - 1] === '') collected.pop();
  return collected;
}

function readBlockScalar(stream, parentIndent, style) {
  const collected = readBlockScalarLines(stream, parentIndent);
  if (style === '>') return foldBlockScalarLines(collected);
  return collected.join('\n') + '\n';
}

function foldBlockScalarLines(lines) {
  const chunks = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    chunks.push(paragraph.join(' '));
    paragraph = [];
  };
  for (const line of lines) {
    if (line === '') {
      flushParagraph();
      chunks.push('');
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return chunks.join('\n') + '\n';
}

// Parse a scalar / flow value.
function parseValue(s) {
  s = s.trim();
  if (s === '') return null;
  if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (s.startsWith('{') && s.endsWith('}')) return parseFlowMapping(s);
  if (s.startsWith('[') && s.endsWith(']')) return parseFlowSequence(s);
  if (s.startsWith('"') || s.startsWith("'")) return unquote(s);
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(s)) return parseFloat(s);
  if (/^-?\d+[eE][+-]?\d+$/.test(s)) return parseFloat(s);
  return s;
}

function unquote(s) {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    // Reuse JSON's parser for double-quoted strings — close enough for the
    // canonical example's escape vocabulary (\n, \t, \", \\, etc.).
    return JSON.parse(s);
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function parseFlowMapping(s) {
  const inner = s.slice(1, -1).trim();
  if (inner === '') return {};
  const parts = splitFlow(inner, ',');
  const out = {};
  for (const part of parts) {
    const p = part.trim();
    if (p === '') continue;
    const colon = findMappingColon(p);
    if (colon === -1) {
      throw new Error(`yaml flow mapping: expected "k: v" in ${JSON.stringify(p)}`);
    }
    const k = unquote(p.slice(0, colon).trim());
    const v = parseValue(p.slice(colon + 1).trim());
    out[k] = v;
  }
  return out;
}

function parseFlowSequence(s) {
  const inner = s.slice(1, -1).trim();
  if (inner === '') return [];
  return splitFlow(inner, ',').map(p => parseValue(p.trim()));
}

// ============================================================
// Emitter — minimal block-style YAML writer. Symmetric to the parser:
// output round-trips through parse() back to a structurally equal value.
//
// Emits: block mappings, block sequences, literal block scalars (`|`),
// quoted strings when ambiguous, JSON-style scalars for numbers /
// booleans / null. Compact (no empty containers as inline `{}`/`[]`).
// ============================================================

const BLOCK_SCALAR_LENGTH = 4096;

export function emit(value, opts = {}) {
  const indent = opts.indent || 2;
  const out = emitValue(value, 0, indent, true);
  return out.endsWith('\n') ? out : out + '\n';
}

function emitValue(value, depth, indent, topLevel = false) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return String(value);
    return 'null'; // NaN / Infinity not representable; lose with care
  }
  if (typeof value === 'string') return emitScalarString(value);
  if (Array.isArray(value)) return emitSequence(value, depth, indent, topLevel);
  if (typeof value === 'object') return emitMapping(value, depth, indent, topLevel);
  return 'null';
}

function emitScalarString(s) {
  if (s === '') return "''";
  // Multi-line: use a literal block scalar. Caller handles placement.
  // We tag the result with a sentinel `__BLOCK__` so the parent renderer
  // knows to format it correctly. (Single-line emission shouldn't see this.)
  if (shouldEmitBlockScalarString(s)) return '__BLOCK__:' + s;
  if (needsQuoting(s)) return JSON.stringify(s); // double-quoted with JSON escapes
  return s;
}

function shouldEmitBlockScalarString(s) {
  return s.includes('\n') || s.length > BLOCK_SCALAR_LENGTH;
}

function needsQuoting(s) {
  if (s.length === 0) return true;
  // Special YAML keywords
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true;
  // Numeric-looking
  if (/^[-+]?(\d+(\.\d+)?([eE][-+]?\d+)?|\.\d+([eE][-+]?\d+)?)$/.test(s)) return true;
  // Leading sigils / whitespace / structural chars
  if (/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true;
  // Trailing whitespace would lose data on parse
  if (/[\s]$/.test(s)) return true;
  // Embedded ": " (mapping ambiguity) or " #" (comment ambiguity)
  if (/: /.test(s)) return true;
  if (/ #/.test(s)) return true;
  return false;
}

function emitMapping(obj, depth, indent, topLevel) {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '{}';
  const pad = ' '.repeat(depth * indent);
  const childPad = ' '.repeat((depth + 1) * indent);
  const lines = [];
  for (const k of keys) {
    const v = obj[k];
    const key = emitKey(k);
    if (v === null || v === undefined) {
      lines.push(`${pad}${key}: null`);
      continue;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) { lines.push(`${pad}${key}: []`); continue; }
      lines.push(`${pad}${key}:`);
      lines.push(emitSequence(v, depth + 1, indent));
      continue;
    }
    if (typeof v === 'object') {
      if (Object.keys(v).length === 0) { lines.push(`${pad}${key}: {}`); continue; }
      lines.push(`${pad}${key}:`);
      lines.push(emitMapping(v, depth + 1, indent));
      continue;
    }
    if (typeof v === 'string' && shouldEmitBlockScalarString(v)) {
      lines.push(`${pad}${key}: |`);
      // strip trailing single newline so block content doesn't double-up
      const content = v.replace(/\n$/, '');
      for (const line of content.split('\n')) lines.push(childPad + line);
      continue;
    }
    lines.push(`${pad}${key}: ${emitValue(v, depth + 1, indent)}`);
  }
  return lines.join('\n');
}

function emitSequence(arr, depth, indent) {
  const pad = ' '.repeat(depth * indent);
  // YAML compact sequence: continuation keys indent past `- ` (2 spaces).
  const lines = [];
  for (const item of arr) {
    if (item === null || item === undefined) { lines.push(`${pad}- null`); continue; }
    if (Array.isArray(item)) {
      if (item.length === 0) { lines.push(`${pad}- []`); continue; }
      lines.push(`${pad}-`);
      lines.push(emitSequence(item, depth + 1, indent));
      continue;
    }
    if (typeof item === 'object') {
      if (Object.keys(item).length === 0) { lines.push(`${pad}- {}`); continue; }
      // If the first key has a complex value (non-empty array/mapping or
      // multi-line string), emit `-` on its own line and the full mapping
      // one level deeper. Otherwise use the compact form: first key inline
      // with `- `, remaining keys at `depth + 1`. This avoids producing the
      // "- key:\n    <nested>" pattern which forks YAML parsers around the
      // continuation indent.
      const firstKey = Object.keys(item)[0];
      const firstVal = item[firstKey];
      const firstIsComplex =
        (Array.isArray(firstVal) && firstVal.length > 0) ||
        (firstVal !== null && typeof firstVal === 'object' && Object.keys(firstVal).length > 0) ||
        (typeof firstVal === 'string' && shouldEmitBlockScalarString(firstVal));
      if (firstIsComplex) {
        lines.push(`${pad}-`);
        lines.push(emitMapping(item, depth + 1, indent));
        continue;
      }
      const mapLines = emitMapping(item, depth + 1, indent).split('\n');
      const childPad = ' '.repeat((depth + 1) * indent);
      const head = `${pad}- ` + mapLines[0].slice(childPad.length);
      lines.push(head);
      for (let i = 1; i < mapLines.length; i++) lines.push(mapLines[i]);
      continue;
    }
    if (typeof item === 'string' && shouldEmitBlockScalarString(item)) {
      lines.push(`${pad}- |`);
      const content = item.replace(/\n$/, '');
      const childPad = ' '.repeat((depth + 1) * indent);
      for (const line of content.split('\n')) lines.push(childPad + line);
      continue;
    }
    lines.push(`${pad}- ${emitValue(item, depth + 1, indent)}`);
  }
  return lines.join('\n');
}

function emitKey(k) {
  // Most keys are bare identifiers. Quote if the key would be ambiguous.
  if (typeof k !== 'string') k = String(k);
  if (k === '') return "''";
  if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k)) return k;
  if (needsQuoting(k) || /[:#]/.test(k)) return JSON.stringify(k);
  return k;
}

// ============================================================
// Internal: shared splitFlow utility for the parser.
// ============================================================

// Split a flow string by `sep`, respecting nested brackets and quotes.
function splitFlow(s, sep) {
  const out = [];
  let buf = '';
  let inSingle = false, inDouble = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) {
      buf += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '\\' && i + 1 < s.length) { buf += c + s[i + 1]; i++; continue; }
      buf += c;
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") { inSingle = true; buf += c; continue; }
    if (c === '"') { inDouble = true; buf += c; continue; }
    if (c === '{' || c === '[') { depth++; buf += c; continue; }
    if (c === '}' || c === ']') { depth--; buf += c; continue; }
    if (c === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  out.push(buf);
  return out;
}
