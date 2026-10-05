import type { RtdbRulesDocument } from 'pyric/rules/internal/rtdb';
import { stripJsonComments, toStrictRulesJson } from 'pyric/sandbox/database';

// One reader for rules text, shared with the sandbox foundation.
export { stripJsonComments, toStrictRulesJson };

export interface RtdbRulesJson {
  rules: Record<string, unknown>;
}

export function isRtdbRulesJson(value: unknown): value is RtdbRulesJson {
  return isRtdbRulesObject(value) && isRtdbRulesObject(value.rules);
}

export function parseRtdbRulesJson(
  value: unknown,
  onInvalid: () => Error,
): RtdbRulesJson {
  if (!isRtdbRulesJson(value)) throw onInvalid();
  return value;
}

export function isRtdbRulesDocument(value: unknown): value is RtdbRulesDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  );
}

function isRtdbRulesObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the text of a Realtime Database rules file into a `{ rules }` document.
 * The text may carry what a deployed rules file may: line and block comments,
 * rule expressions broken across lines, and trailing commas (see
 * `toStrictRulesJson`). `rules lint`, `rules simulate`, `rules set`,
 * `database rules validate`, `verify`, and the served sandbox's rules loader
 * parse rules text here, so they accept the same files. `onInvalid` receives
 * the reason the text is not a rules document and returns the error to throw.
 */
export function parseRtdbRulesText(
  text: string,
  onInvalid: (error: Error) => Error,
): RtdbRulesJson {
  const clean = toStrictRulesJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw onInvalid(new Error(`not valid JSON: ${detail}`));
  }
  return parseRtdbRulesJson(parsed, () => onInvalid(new Error('no top-level "rules" object')));
}
