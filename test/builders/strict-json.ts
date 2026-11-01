/**
 * JSON as the forwarder reads a request body: `JSON.parse`, after a scan
 * that refuses any object repeating a key at any depth. `JSON.parse` keeps
 * the last of a repeated key and another parser may keep the first, so a
 * body that repeats `max_tokens`, `tools` or `model` could be checked as one
 * request and run as another. Keys are compared decoded, so `"max"`
 * repeats `"max"`. Before any of that, a body nested deeper than
 * `MAX_DEPTH` is refused, measured by a loop over the text.
 */

export type StrictJson = { kind: 'value'; value: unknown } | { kind: 'malformed' } | { kind: 'too-deep' } | { kind: 'duplicate-key'; key: string };

/**
 * The deepest nesting of objects and arrays a body may have. Claude Code's
 * requests nest a handful of levels. The limit keeps every walk of the body,
 * recursive ones included, far from the stack's depth.
 */
export const MAX_DEPTH = 64;

interface Frame {
  keys: Set<string> | undefined;
  expectKey: boolean;
}

/** The end of the string literal starting at `start` (its opening quote), just past the closing quote. */
function stringEnd(text: string, start: number): number {
  let at = start + 1;
  while (at < text.length) {
    const char = text[at];
    if (char === '\\') at += 2;
    else if (char === '"') return at + 1;
    else at += 1;
  }
  return -1;
}

/** The first key repeated within one object, scanning text that `JSON.parse` has accepted. */
export function repeatedKey(text: string): string | undefined {
  const stack: Frame[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    const frame = stack.at(-1);
    if (char === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (char === '[') stack.push({ keys: undefined, expectKey: false });
    else if (char === '}' || char === ']') stack.pop();
    else if (char === ',' && frame?.keys !== undefined) frame.expectKey = true;
    else if (char === '"') {
      const end = stringEnd(text, at);
      if (frame?.keys !== undefined && frame.expectKey) {
        const key = JSON.parse(text.slice(at, end)) as string;
        if (frame.keys.has(key)) return key;
        frame.keys.add(key);
        frame.expectKey = false;
      }
      at = end;
      continue;
    }
    at += 1;
  }
  return undefined;
}

/** Whether `text` nests objects and arrays deeper than `limit`, outside strings. A loop, not a recursion, so any depth is safe to measure. */
export function nestsDeeperThan(text: string, limit: number): boolean {
  let depth = 0;
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === '"') {
      const end = stringEnd(text, at);
      if (end === -1) return false;
      at = end;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
    if (depth > limit) return true;
    at += 1;
  }
  return false;
}

/** The body as a value, once it is shallow enough to walk, valid JSON, and free of repeated keys. */
export function parseStrictJson(text: string): StrictJson {
  if (nestsDeeperThan(text, MAX_DEPTH)) return { kind: 'too-deep' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'malformed' };
  }
  const key = repeatedKey(text);
  return key === undefined ? { kind: 'value', value } : { kind: 'duplicate-key', key };
}
