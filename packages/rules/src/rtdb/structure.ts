import type { RtdbStructuralFinding } from './types.js';

/** The keys that carry a rule or an index declaration rather than a child location. */
export const SYSTEM_KEYS: ReadonlySet<string> = new Set(['.read', '.write', '.validate', '.indexOn']);

const RULE_KEYS: ReadonlySet<string> = new Set(['.read', '.write', '.validate']);

/** A character a key may not hold: `.`, `#`, `$`, `/`, `[` or `]`. */
export const FORBIDDEN_KEY_CHARACTER = /[.#$/[\]]/;

/**
 * The texts production's deploy reports for each shape problem, captured from
 * a deploy of each construct.
 */
const INVALID_RULE_EXPRESSION =
  "Invalid rule expression.  Expected 'true', 'false', or an expression string.";
const INVALID_INDEX_ON = 'Invalid indexOn expression. Must be either a string or an array of strings';
const INVALID_KEY_TEXT = `String can't contain ".", "#", "$", "/", "[", or "]"`;
const EXPECTED_OBJECT = "Expected '{'.";
const invalidIndexKey = (entry: string): string =>
  `Invalid key: ${entry}. Index must be either .value or declared on a valid path`;

/**
 * The findings for each `.indexOn` entry that is neither `.value` nor a
 * child path. r51 captures production refusing `x.y` and accepting `x/y`
 * and `''`, so an entry with a `.` in a segment is an error; one with `#`,
 * `$`, `[` or `]` is a warning, inferred from the refusal's text.
 */
function indexEntryFindings(value: unknown, add: (message: string, severity: 'error' | 'warning') => void): void {
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry === '.value') continue;
    const segments = entry.split('/');
    if (segments.some((segment) => segment.includes('.'))) add(invalidIndexKey(entry), 'error');
    else if (segments.some((segment) => FORBIDDEN_KEY_CHARACTER.test(segment))) add(invalidIndexKey(entry), 'warning');
  }
}

/**
 * The shape problems one rules object carries, in key order. A form whose
 * production deploy rejection was captured is an error and refuses the
 * ruleset. A form that is only inferred from the text of a captured rejection
 * (a key holding `.`, `/`, `[`, `]` or an inner `$` but not `#`, and an
 * `.indexOn` that is not a number but still not a string or string array) is
 * a warning until it is captured.
 */
export function structuralFindings(
  path: string,
  rulesObj: Record<string, unknown>,
): RtdbStructuralFinding[] {
  const findings: RtdbStructuralFinding[] = [];
  const add = (
    code: RtdbStructuralFinding['code'],
    message: string,
    severity: RtdbStructuralFinding['severity'] = 'error',
  ): void => {
    findings.push({ path, code, message, severity });
  };

  const wildcards: string[] = [];
  for (const [key, value] of Object.entries(rulesObj)) {
    if (RULE_KEYS.has(key)) {
      if (typeof value !== 'string' && typeof value !== 'boolean') {
        const captured = typeof value === 'number' || (typeof value === 'object' && value !== null);
        add('RULE_NOT_EXPRESSION', INVALID_RULE_EXPRESSION, captured ? 'error' : 'warning');
      }
      continue;
    }
    if (key === '.indexOn') {
      const isName = (item: unknown): boolean => typeof item === 'string';
      const valid = isName(value) || (Array.isArray(value) && value.every(isName));
      if (!valid) add('INDEX_ON_SHAPE', INVALID_INDEX_ON, typeof value === 'number' ? 'error' : 'warning');
      else indexEntryFindings(value, (message, severity) => add('INVALID_KEY', message, severity));
      continue;
    }
    const isPlainObject = typeof value === 'object' && value !== null && !Array.isArray(value);
    if (key.startsWith('.')) {
      // An unknown dotted key names no rule and no location.
      if (isPlainObject) add('INVALID_KEY', INVALID_KEY_TEXT);
      else add('EXPECTED_OBJECT', EXPECTED_OBJECT);
      continue;
    }
    if (key.startsWith('$')) wildcards.push(key);
    const name = key.startsWith('$') ? key.slice(1) : key;
    if (FORBIDDEN_KEY_CHARACTER.test(name)) {
      add('INVALID_KEY', INVALID_KEY_TEXT, name.includes('#') ? 'error' : 'warning');
    }
    else if (!isPlainObject) add('EXPECTED_OBJECT', EXPECTED_OBJECT);
  }
  if (wildcards.length > 1) {
    add(
      'MULTIPLE_WILDCARDS',
      `Cannot have multiple default rules ('${wildcards[0]}' and '${wildcards[1]}').`,
    );
  }
  return findings;
}
