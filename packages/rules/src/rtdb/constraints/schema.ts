import { z } from 'zod';
import type { Expr } from './types.js';
import { all, any, expr, fieldName as assertFieldName, lit } from './compose.js';
import { hasChild, hasChildren } from './atoms.js';
import { isSupportedRegexFlags } from '../grammar/type-rules.js';
import { rtdbRegexError } from '../grammar/regex.js';

export interface SchemaFieldRule {
  validate: Expr;
  children?: Record<string, SchemaFieldRule>;
}

export interface SchemaRulesResult {
  validate: Expr;
  children: Record<string, SchemaFieldRule>;
}

interface Zod4CheckDef {
  check?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  length?: number;
  pattern?: RegExp;
  prefix?: string;
  suffix?: string;
  includes?: string;
  position?: number;
  value?: number;
  inclusive?: boolean;
}

interface Zod4Check {
  _zod?: { def?: Zod4CheckDef };
}

interface Zod4TypeDef {
  type?: string;
  format?: string;
  catchall?: Zod4Schema;
  innerType?: Zod4Schema;
  checks?: readonly Zod4Check[];
  entries?: Record<string, string | number>;
  values?: readonly unknown[];
  options?: readonly Zod4Schema[];
}

interface Zod4Schema {
  constructor?: { name?: string };
  _zod?: { def?: Zod4TypeDef };
}

const EMAIL_PATTERN = '/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/';

/** Escaped letters that mean the same class in JavaScript and in RTDB's dialect. */
const SHARED_CLASS_ESCAPES = new Set(['d', 'D', 'w', 'W', 's', 'S']);
const QUANTIFIER_ENDS = new Set(['*', '+', '?', '}']);

/**
 * Why a JavaScript regex source cannot become an RTDB `matches()` literal
 * with the same meaning, or null when it can. RTDB reads `\b` as `b`, `\1` as
 * `1`, `(?` as a literal `?`, and `+?` as an optional `+` (#1247 SP-2b; r47,
 * r50), and refuses a mid-pattern anchor or `\p{..}` at deploy (SP-1, SP-2a).
 * Its anchor rewrite puts `.*` around the pattern with no group (r53), so a
 * top-level `|` splits differently, and a `]` that opens a set is a member.
 *
 * Two gaps stay open, because the dialect cannot spell JavaScript's sets:
 *   - JavaScript's `.` refuses the line terminators `\n`, `\r`, U+2028 and
 *     U+2029, and RTDB's matches them (SP-8), so the generated rule accepts a
 *     line terminator the Zod schema refuses;
 *   - JavaScript's `\s` also covers Unicode spaces such as U+00A0, and RTDB's
 *     is ASCII only (r56), so `\s` matches fewer characters and `\S` more.
 * The generated rule emits `.`, `\s` and `\S` unchanged.
 */
function rtdbRegexProblem(source: string): string | null {
  const deployError = rtdbRegexError(source);
  if (deployError !== null) return `RTDB refuses it at deploy (${deployError})`;
  let inClass = false;
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? '';
    const nextCh = source[i + 1];
    if (ch === '\\' && nextCh !== undefined) {
      const escapeProblem = escapedLetterProblem(nextCh);
      if (escapeProblem !== null) return escapeProblem;
      i++;
    } else if (inClass) {
      inClass = ch !== ']';
    } else if (ch === '[') {
      if (startsWithClosingBracket(source, i + 1)) return 'RTDB reads a ] right after [ or [^ as a member of the set';
      inClass = true;
    } else if (ch === '(' && nextCh === '?') {
      return 'RTDB reads (? as a literal ?, so lookarounds and (?: groups never match as in JavaScript';
    } else if (QUANTIFIER_ENDS.has(ch) && nextCh === '?') {
      return 'RTDB has no lazy quantifier and reads +? as an optional +';
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === '|' && isEmptyAlternative(source, i)) {
      return 'RTDB reads the | of an empty alternative, as in (|a) or a||b, as a literal |';
    } else if (ch === '|' && depth === 0) {
      return 'RTDB applies ^, $ and the implied .* to the first and last alternatives only; wrap the alternation in a group';
    }
  }
  return null;
}

/** Whether the `|` at `at` has nothing on one side within its group. */
function isEmptyAlternative(source: string, at: number): boolean {
  const before = source[at - 1];
  const after = source[at + 1];
  const opensGroup = before === '(' && source[at - 2] !== '\\';
  return opensGroup || after === '|' || after === ')';
}

function startsWithClosingBracket(source: string, start: number): boolean {
  const memberStart = source[start] === '^' ? start + 1 : start;
  return source[memberStart] === ']';
}

function escapedLetterProblem(letter: string): string | null {
  const isLetterOrDigit = /^[A-Za-z0-9]$/.test(letter);
  if (!isLetterOrDigit || SHARED_CLASS_ESCAPES.has(letter)) return null;
  if (letter === 'b' || letter === 'B') return `RTDB reads \\${letter} as the letter ${letter}, not a word boundary`;
  if (/^[1-9]$/.test(letter)) return `RTDB reads \\${letter} as the digit ${letter}, not a backreference`;
  return `RTDB reads the escape \\${letter} as the letter ${letter}`;
}

function zodDefOf(value: unknown): Zod4TypeDef | undefined {
  return (value as Zod4Schema | null | undefined)?._zod?.def;
}

/** Rejects Zod 4 `.refine()` / `.superRefine()` / attached checks on types whose rules cannot encode them. */
function assertNoChecks(def: Zod4TypeDef | undefined, kind: string, fieldName?: string): void {
  const checks = def?.checks;
  if (checks === undefined || checks.length === 0) {
    return;
  }
  const first = checks[0]?._zod?.def?.check;
  const target = fieldName === undefined ? '' : ` on field "${fieldName}"`;
  throw new Error(`Unsupported Zod ${kind} check "${String(first)}" for RTDB rules${target}`);
}

/**
 * Generate RTDB validate rules from a Zod 4 object schema.
 * Optional fieldConstraints are AND-composed with the schema type check.
 */
export function schemaRules(
  schema: z.ZodObject<any>,
  fieldConstraints?: Record<string, Expr[]>,
): SchemaRulesResult {
  if (!(schema instanceof z.ZodObject)) {
    const actualName = (schema as unknown as Zod4Schema)?.constructor?.name ?? typeof schema;
    throw new Error(
      `Unsupported Zod schema for RTDB rules: expected ZodObject, got ${actualName}`,
    );
  }
  const def = zodDefOf(schema);
  assertNoChecks(def, 'object');
  const catchallDef = def?.catchall?._zod?.def;
  const catchallType = catchallDef?.type;
  if (catchallType !== undefined && catchallType !== 'never' && catchallType !== 'unknown') {
    throw new Error('Unsupported Zod object catchall for RTDB rules');
  }
  assertNoChecks(catchallDef, 'object catchall');

  const shape = schema.shape;
  if (fieldConstraints) {
    for (const key of Object.keys(fieldConstraints)) {
      if (!(key in shape)) {
        throw new Error(`fieldConstraints: field "${key}" is not in schema.`);
      }
    }
  }

  const requiredFields: string[] = [];
  const children: SchemaRulesResult['children'] = {};

  for (const [key, rawType] of Object.entries(shape)) {
    assertFieldName('schemaRules', key);
    const rawDef = zodDefOf(rawType);
    const isOptional = rawDef?.type === 'optional';
    let innerType: unknown = rawType;
    if (isOptional) {
      assertNoChecks(rawDef, 'optional', key);
      if (rawDef?.innerType !== undefined) {
        innerType = rawDef.innerType;
      }
    }

    if (!isOptional) {
      requiredFields.push(key);
    }

    const constraints = fieldConstraints?.[key];

    if (innerType instanceof z.ZodObject) {
      const nested = schemaRules(innerType);
      let validateExpr = nested.validate;
      if (constraints && constraints.length > 0) {
        validateExpr = all(nested.validate, ...constraints);
      }
      children[key] = {
        validate: validateExpr,
        children: nested.children,
      };
    } else {
      const typeExpr = zodTypeToExpr(innerType, key);
      if (constraints && constraints.length > 0) {
        children[key] = { validate: all(typeExpr, ...constraints) };
      } else {
        children[key] = { validate: typeExpr };
      }
    }
  }

  if (catchallType === 'never') {
    children.$other = { validate: expr('false') };
  }

  // Parent validate: hasChildren + required fields
  const parentParts: Expr[] = [hasChildren()];
  for (const f of requiredFields) {
    parentParts.push(hasChild(f));
  }
  const validate = all(...parentParts);

  return { validate, children };
}

function zodStringFormatToExpr(
  format: string,
  cdef: Zod4CheckDef,
  fieldName: string,
): Expr {
  if (format === 'regex' && cdef.pattern instanceof RegExp) {
    const re = cdef.pattern;
    if (!isSupportedRegexFlags(re.flags)) {
      throw new Error(
        `Unsupported Zod regex flags "${re.flags}" on field "${fieldName}"; RTDB rules only support the "i" flag`,
      );
    }
    if (/[\r\n]/.test(re.source)) {
      throw new Error(`Unsupported Zod regex with newline on field "${fieldName}"`);
    }
    const problem = rtdbRegexProblem(re.source);
    if (problem !== null) {
      throw new Error(`Unsupported Zod regex on field "${fieldName}": ${problem}`);
    }
    return expr(`newData.val().matches(/${re.source}/${re.flags})`);
  }
  if (format === 'email') {
    return expr(`newData.val().matches(${EMAIL_PATTERN})`);
  }
  if (format === 'starts_with' && typeof cdef.prefix === 'string') {
    return expr(`newData.val().beginsWith(${lit(cdef.prefix)})`);
  }
  if (format === 'ends_with' && typeof cdef.suffix === 'string') {
    return expr(`newData.val().endsWith(${lit(cdef.suffix)})`);
  }
  if (format === 'includes' && typeof cdef.includes === 'string') {
    if (cdef.position !== undefined) {
      throw new Error(
        `Unsupported Zod string check "includes" with position for RTDB rules on field "${fieldName}"`,
      );
    }
    return expr(`newData.val().contains(${lit(cdef.includes)})`);
  }
  throw new Error(
    `Unsupported Zod string check "${format}" for RTDB rules on field "${fieldName}"`,
  );
}

function zodStringToExpr(def: Zod4TypeDef, fieldName: string): Expr {
  const parts: Expr[] = [expr('newData.isString()')];
  if (typeof def.format === 'string') {
    parts.push(zodStringFormatToExpr(def.format, def as Zod4CheckDef, fieldName));
  }
  for (const check of def.checks ?? []) {
    const cdef = check._zod?.def;
    if (cdef?.check === 'min_length' && typeof cdef.minimum === 'number') {
      parts.push(expr(`newData.val().length >= ${lit(cdef.minimum)}`));
    } else if (cdef?.check === 'max_length' && typeof cdef.maximum === 'number') {
      parts.push(expr(`newData.val().length <= ${lit(cdef.maximum)}`));
    } else if (cdef?.check === 'length_equals' && typeof cdef.length === 'number') {
      parts.push(expr(`newData.val().length == ${lit(cdef.length)}`));
    } else if (cdef?.check === 'string_format' && typeof cdef.format === 'string') {
      parts.push(zodStringFormatToExpr(cdef.format, cdef, fieldName));
    } else {
      throw new Error(
        `Unsupported Zod string check "${String(cdef?.check)}" for RTDB rules on field "${fieldName}"`,
      );
    }
  }
  return all(...parts);
}

function zodNumberToExpr(def: Zod4TypeDef, fieldName: string): Expr {
  const parts: Expr[] = [expr('newData.isNumber()')];
  if (def.format === 'safeint') {
    parts.push(expr('newData.val() % 1 == 0'));
  } else if (def.format !== undefined) {
    throw new Error(
      `Unsupported Zod number check "${def.format}" for RTDB rules on field "${fieldName}"`,
    );
  }
  for (const check of def.checks ?? []) {
    const cdef = check._zod?.def;
    if (cdef?.check === 'greater_than' && typeof cdef.value === 'number') {
      const op = cdef.inclusive === false ? '>' : '>=';
      parts.push(expr(`newData.val() ${op} ${lit(cdef.value)}`));
    } else if (cdef?.check === 'less_than' && typeof cdef.value === 'number') {
      const op = cdef.inclusive === false ? '<' : '<=';
      parts.push(expr(`newData.val() ${op} ${lit(cdef.value)}`));
    } else if (cdef?.check === 'number_format' && cdef.format === 'safeint') {
      parts.push(expr('newData.val() % 1 == 0'));
    } else if (cdef?.check === 'number_format') {
      throw new Error(
        `Unsupported Zod number check "${String(cdef.format)}" for RTDB rules on field "${fieldName}"`,
      );
    } else if (cdef?.check === 'multiple_of' && typeof cdef.value === 'number') {
      parts.push(expr(`newData.val() % ${lit(cdef.value)} == 0`));
    } else {
      throw new Error(
        `Unsupported Zod number check "${String(cdef?.check)}" for RTDB rules on field "${fieldName}"`,
      );
    }
  }
  return all(...parts);
}

function zodTypeToExpr(zodType: unknown, fieldName: string): Expr {
  const schema = zodType as Zod4Schema | null | undefined;
  const def = schema?._zod?.def;
  if (def?.type === 'string') {
    return zodStringToExpr(def, fieldName);
  }
  if (def?.type === 'number') {
    return zodNumberToExpr(def, fieldName);
  }
  if (def?.type === 'boolean') {
    assertNoChecks(def, 'boolean', fieldName);
    return expr('newData.isBoolean()');
  }
  if (def?.type === 'enum' && def.entries !== undefined) {
    assertNoChecks(def, 'enum', fieldName);
    const values = Array.from(new Set(Object.values(def.entries)));
    if (values.length === 0) {
      throw new Error(`Unsupported empty Zod enum for RTDB rules on field "${fieldName}"`);
    }
    return any(...values.map((v) => expr(`newData.val() == ${lit(v)}`)));
  }
  if (def?.type === 'literal' && Array.isArray(def.values)) {
    assertNoChecks(def, 'literal', fieldName);
    if (def.values.length === 0) {
      throw new Error(`Unsupported empty Zod literal for RTDB rules on field "${fieldName}"`);
    }
    return any(...def.values.map((v) => expr(`newData.val() == ${lit(v)}`)));
  }
  if (def?.type === 'union' && Array.isArray(def.options)) {
    assertNoChecks(def, 'union', fieldName);
    if (def.options.length === 0) {
      throw new Error(`Unsupported empty Zod union for RTDB rules on field "${fieldName}"`);
    }
    return any(...def.options.map((opt) => zodTypeToExpr(opt, fieldName)));
  }

  const typeName = schema?.constructor?.name ?? String(def?.type ?? typeof zodType);
  throw new Error(`Unsupported Zod type for RTDB rules: ${typeName} on field "${fieldName}"`);
}
