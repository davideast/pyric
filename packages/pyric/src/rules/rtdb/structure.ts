import type { RtdbStructuralFinding } from './types.js';

/** The keys that carry a rule or an index declaration rather than a child location. */
export const SYSTEM_KEYS: ReadonlySet<string> = new Set(['.read', '.write', '.validate', '.indexOn']);

const RULE_KEYS: ReadonlySet<string> = new Set(['.read', '.write', '.validate']);

/** A character a key may not hold: `.`, `#`, `$`, `/`, `[` or `]`. */
const FORBIDDEN_KEY_CHARACTER = /[.#$/[\]]/;

/**
 * The texts production's deploy reports for each shape problem, captured from
 * a deploy of each construct.
 */
const INVALID_RULE_EXPRESSION =
  "Invalid rule expression.  Expected 'true', 'false', or an expression string.";
const INVALID_INDEX_ON = 'Invalid indexOn expression. Must be either a string or an array of strings';
const INVALID_KEY_TEXT = `String can't contain ".", "#", "$", "/", "[", or "]"`;
const EXPECTED_OBJECT = "Expected '{'.";

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
        const captured = typeof value === 'number' || (typeof value === 'object' && value !== null && !Array.isArray(value));
        add('RULE_NOT_EXPRESSION', INVALID_RULE_EXPRESSION, captured ? 'error' : 'warning');
      }
      continue;
    }
    if (key === '.indexOn') {
      const isName = (item: unknown): boolean => typeof item === 'string';
      const valid = isName(value) || (Array.isArray(value) && value.every(isName));
      if (!valid) add('INDEX_ON_SHAPE', INVALID_INDEX_ON, typeof value === 'number' ? 'error' : 'warning');
      continue;
    }
    const isObject = typeof value === 'object' && value !== null;
    if (key.startsWith('.')) {
      // An unknown dotted key names no rule and no location.
      if (isObject) add('INVALID_KEY', INVALID_KEY_TEXT);
      else if (typeof value === 'string') add('EXPECTED_OBJECT', EXPECTED_OBJECT);
      continue;
    }
    if (key.startsWith('$')) wildcards.push(key);
    const name = key.startsWith('$') ? key.slice(1) : key;
    if (FORBIDDEN_KEY_CHARACTER.test(name)) {
      add('INVALID_KEY', INVALID_KEY_TEXT, name.includes('#') ? 'error' : 'warning');
    }
    else if (typeof value === 'string') add('EXPECTED_OBJECT', EXPECTED_OBJECT);
  }
  if (wildcards.length > 1) {
    add(
      'MULTIPLE_WILDCARDS',
      `Cannot have multiple default rules ('${wildcards[0]}' and '${wildcards[1]}').`,
    );
  }
  return findings;
}
