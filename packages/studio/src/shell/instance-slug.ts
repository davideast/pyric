/**
 * Deterministic, memorable rendering of a sandbox `instanceId`, so a user can
 * SAY which sandbox they mean (e.g. "the teal-fox one") instead of squinting at
 * a UUID. Same-port-different-profile sandboxes get different ids, so they get
 * different slugs. 12 x 12 = 144 combinations — enough to disambiguate the handful
 * of instances a person juggles across browser profiles.
 */
const ADJECTIVES = [
  'amber', 'teal', 'coral', 'slate', 'olive', 'plum',
  'rust', 'indigo', 'mint', 'sand', 'ash', 'jade',
];
const ANIMALS = [
  'fox', 'owl', 'lynx', 'crane', 'otter', 'wren',
  'ibex', 'hare', 'newt', 'moth', 'seal', 'vole',
];

export function instanceSlug(id: string): string {
  if (!id) return '';
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
  return `${ADJECTIVES[h % ADJECTIVES.length]}-${ANIMALS[(h >>> 4) % ANIMALS.length]}`;
}
