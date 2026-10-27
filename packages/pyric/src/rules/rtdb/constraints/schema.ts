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
 * One gap stays open: JavaScript's `.` refuses `\n` and `\r` and RTDB's
 * matches them (SP-8), and the dialect has no way to say "any character but a
 * newline". The generated rule emits `.` unchanged, so it accepts a line break
 * the Zod schema refuses.
 */
function rtdbRegexProblem(source: string): string | null {
  const deployError = rtdbRegexError(source);
  if (deployError !== null) return `RTDB refuses it at deploy (${deployError})`;
  let inClass = false;
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
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
    } else if (ch === '|' && depth === 0) {
      return 'RTDB applies ^, $ and the implied .* to the first and last alternatives only; wrap the alternation in a group';
    }
  }
  return null;
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

/**
 * Generate RTDB validate rules from a Zod object schema.
 * Optional fieldConstraints are AND-composed with the schema type check.
 */
export function schemaRules(
  schema: z.ZodObject<any>,
  fieldConstraints?: Record<string, Expr[]>,
): SchemaRulesResult {
  if (!(schema instanceof z.ZodObject)) {
    const actualName = (schema as unknown as { constructor?: { name?: string } })?.constructor?.name ?? typeof schema;
    throw new Error(
      `Unsupported Zod schema for RTDB rules: expected ZodObject, got ${actualName}`,
    );
  }
  const def = schema._def;
  if (def.catchall && !(def.catchall instanceof z.ZodNever)) {
    throw new Error('Unsupported Zod object catchall for RTDB rules');
  }

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
    const zodType = rawType as z.ZodTypeAny;
    const isOptional = zodType instanceof z.ZodOptional;
    const innerType = isOptional ? (zodType as z.ZodOptional<any>).unwrap() : zodType;

    if (!isOptional) requiredFields.push(key);

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

  if (def?.unknownKeys === 'strict') {
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

function zodStringToExpr(zodType: z.ZodString, fieldName: string): Expr {
  const parts: Expr[] = [expr('newData.isString()')];
  for (const check of zodType._def.checks) {
    if (check.kind === 'min') {
      parts.push(expr(`newData.val().length >= ${lit(check.value)}`));
    } else if (check.kind === 'max') {
      parts.push(expr(`newData.val().length <= ${lit(check.value)}`));
    } else if (check.kind === 'length') {
      parts.push(expr(`newData.val().length == ${lit(check.value)}`));
    } else if (check.kind === 'regex') {
      const re = check.regex;
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
      parts.push(expr(`newData.val().matches(/${re.source}/${re.flags})`));
    } else if (check.kind === 'email') {
      parts.push(expr(`newData.val().matches(${EMAIL_PATTERN})`));
    } else if (check.kind === 'startsWith') {
      parts.push(expr(`newData.val().beginsWith(${lit(check.value)})`));
    } else if (check.kind === 'endsWith') {
      parts.push(expr(`newData.val().endsWith(${lit(check.value)})`));
    } else if (check.kind === 'includes') {
      parts.push(expr(`newData.val().contains(${lit(check.value)})`));
    } else {
      throw new Error(
        `Unsupported Zod string check "${String(check.kind)}" for RTDB rules on field "${fieldName}"`,
      );
    }
  }
  return all(...parts);
}

function zodNumberToExpr(zodType: z.ZodNumber, fieldName: string): Expr {
  const parts: Expr[] = [expr('newData.isNumber()')];
  for (const check of zodType._def.checks) {
    if (check.kind === 'min') {
      const op = check.inclusive === false ? '>' : '>=';
      parts.push(expr(`newData.val() ${op} ${lit(check.value)}`));
    } else if (check.kind === 'max') {
      const op = check.inclusive === false ? '<' : '<=';
      parts.push(expr(`newData.val() ${op} ${lit(check.value)}`));
    } else if (check.kind === 'int') {
      parts.push(expr('newData.val() % 1 == 0'));
    } else if (check.kind === 'multipleOf') {
      parts.push(expr(`newData.val() % ${lit(check.value)} == 0`));
    } else {
      throw new Error(
        `Unsupported Zod number check "${String(check.kind)}" for RTDB rules on field "${fieldName}"`,
      );
    }
  }
  return all(...parts);
}

function zodTypeToExpr(zodType: z.ZodTypeAny, fieldName: string): Expr {
  if (zodType instanceof z.ZodString) {
    return zodStringToExpr(zodType, fieldName);
  }
  if (zodType instanceof z.ZodNumber) {
    return zodNumberToExpr(zodType, fieldName);
  }
  if (zodType instanceof z.ZodBoolean) {
    return expr('newData.isBoolean()');
  }
  if (zodType instanceof z.ZodEnum) {
    const values = (zodType as z.ZodEnum<any>).options as string[];
    return any(...values.map(v => expr(`newData.val() == ${lit(v)}`)));
  }
  if (zodType instanceof z.ZodLiteral) {
    const v = (zodType as z.ZodLiteral<any>).value;
    return expr(`newData.val() == ${lit(v)}`);
  }
  if (zodType instanceof z.ZodUnion) {
    const options = (zodType as z.ZodUnion<any>)._def.options as z.ZodTypeAny[];
    return any(...options.map(opt => zodTypeToExpr(opt, fieldName)));
  }

  throw new Error(`Unsupported Zod type for RTDB rules: ${zodType.constructor.name} on field "${fieldName}"`);
}
