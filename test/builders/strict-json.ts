/**
 * JSON as the forwarder reads a request body: `JSON.parse`, after a scan
 * that refuses any object repeating a key at any depth. `JSON.parse` keeps
 * the last of a repeated key and another parser may keep the first, so a
 * body that repeats `max_tokens`, `tools` or `model` could be checked as one
 * request and run as another. Keys are compared decoded, so `"max"`
 * repeats `"max"`.
 */

export type StrictJson = { kind: 'value'; value: unknown } | { kind: 'malformed' } | { kind: 'duplicate-key'; key: string };

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

export function parseStrictJson(text: string): StrictJson {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'malformed' };
  }
  const key = repeatedKey(text);
  return key === undefined ? { kind: 'value', value } : { kind: 'duplicate-key', key };
}
