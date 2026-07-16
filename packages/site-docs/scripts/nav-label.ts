const STRIP_PREFIXES = [/^How to /i, /^Use the /i, /^Use /i, /^Build a /i, /^Set up /i, /^Write a /i];

/** Heuristic sidebar label from a page title. Pages that need a curated
 * label author `navLabel` in their own front matter (one label per record;
 * no master list); generated conformance pages carry their catalog label. */
export function navLabelFor(title: string): string {
  let short = title.split(' — ')[0].split(': ')[0].trim();
  for (const pattern of STRIP_PREFIXES) {
    if (!pattern.test(short)) continue;
    short = short.replace(pattern, '').trim();
    short = short.charAt(0).toUpperCase() + short.slice(1);
    break;
  }
  return short;
}
