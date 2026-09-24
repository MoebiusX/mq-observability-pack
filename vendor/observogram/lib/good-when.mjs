// tools/lib/good-when.mjs
//
// The direction of a threshold or distribution SLI's bound (ObservabilityPack spec 1.3,
// RFC-0002): `good_when: below` — the default, and the only meaning a 1.2 pack could express —
// is a ceiling: a sample is good when it is at or below `threshold` (latency, lag, error rate,
// queue age); `good_when: above` is a floor: good at or above it (in-sync replicas, connected
// consumers, free capacity, throughput). The bound itself is good either way: the bad side is
// strict (`>` the bound for a ceiling, `<` it for a floor).
//
// Absent means below, and this module is the one place that says so: every reader — the
// burn-rate generator, the dashboards, the adapter, the library engine, the CLI — asks
// goodWhen(sli) and never the raw field, so a 1.2 pack reads exactly as it did. Zero imports,
// browser-safe. The studio re-spells it for the browser (studio/sli-direction.mjs, zero imports:
// a studio module cannot import tools/lib) and tools/test-build-model.mjs holds the two together
// input for input.

export const GOOD_WHEN = Object.freeze(['below', 'above']);
export const DEFAULT_GOOD_WHEN = 'below';
/** The SLI types that carry a bound, and so a direction (the schema refuses the field elsewhere). */
export const DIRECTED_TYPES = Object.freeze(['threshold', 'distribution']);

/** The effective direction of an SLI: 'above' when it says so, else 'below' — absent, null, or a value the schema would have refused. */
export function goodWhen(sli) {
  return sli?.good_when === 'above' ? 'above' : DEFAULT_GOOD_WHEN;
}
/** Whether an SLI type carries a bound. */
export const hasDirection = (type) => DIRECTED_TYPES.includes(type);
/** The comparison that selects the BAD samples: `>` for a ceiling (bad above the bound), `<` for a floor (bad under it). The bound itself is good either way. */
export const badComparator = (sli) => (goodWhen(sli) === 'above' ? '<' : '>');
/** The glyph a card prints before the bound: ≤ for a ceiling (good at or below it), ≥ for a floor (good at or above it). */
export const boundGlyph = (sli) => (goodWhen(sli) === 'above' ? '≥' : '≤');
/** The bound as a card or a panel description prints it: '≤ 0.5 seconds', '≥ 2 consumers' ('≤ 0.5' without a unit; '' without a bound). */
export function boundText(sli) {
  const t = sli?.threshold;
  const n = typeof t === 'number' ? String(t) : String(t ?? '').trim();
  if (!n) return '';
  const unit = String(sli?.unit ?? '').trim();
  return `${boundGlyph(sli)} ${n}${unit ? ` ${unit}` : ''}`;
}
