/**
 * Inline value-editor logic (pure): the type select + text input pair used by
 * the tree's click-to-edit and add-child rows. Four author-facing types cover
 * every RTDB value: string / number / boolean scalars, and `json` for
 * objects/arrays/null (or any hand-written literal).
 */

export type RtdbEditorType = 'string' | 'number' | 'boolean' | 'json';

export const RTDB_EDITOR_TYPES: readonly RtdbEditorType[] = [
  'string',
  'number',
  'boolean',
  'json',
];

/** The editor type a value opens under when clicked. */
export function inferRtdbEditorType(value: unknown): RtdbEditorType {
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'json';
  }
}

/** Seed the editor's text field from the current value under a type. */
export function formatRtdbEditorValue(value: unknown, type: RtdbEditorType): string {
  if (type === 'json') return JSON.stringify(value ?? null);
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Why a typed child key is unusable, or `null` when it's fine. RTDB forbids
 *  `. $ # [ ] /` in keys (a `/` would silently create a nested path). */
export function rtdbKeyInputError(key: string): string | null {
  if (key.trim().length === 0) return 'Enter a key.';
  const bad = key.match(/[.$#[\]/]/);
  if (bad) return `Keys can't contain "${bad[0]}".`;
  return null;
}

export type RtdbEditorResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** Coerce the editor's text under the selected type, or explain why not. */
export function coerceRtdbEditorValue(type: RtdbEditorType, text: string): RtdbEditorResult {
  switch (type) {
    case 'string':
      return { ok: true, value: text };
    case 'number': {
      const trimmed = text.trim();
      if (trimmed.length === 0) return { ok: false, error: 'Enter a number.' };
      const n = Number(trimmed);
      if (Number.isNaN(n)) return { ok: false, error: `"${text}" is not a number.` };
      return { ok: true, value: n };
    }
    case 'boolean': {
      const t = text.trim().toLowerCase();
      if (t === 'true') return { ok: true, value: true };
      if (t === 'false') return { ok: true, value: false };
      return { ok: false, error: 'Enter true or false.' };
    }
    case 'json': {
      const t = text.trim();
      if (t.length === 0) return { ok: true, value: null };
      try {
        return { ok: true, value: JSON.parse(t) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON.' };
      }
    }
  }
}
