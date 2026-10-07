/**
 * `validation`: the type and value of a written node, and the closed shape of
 * a record.
 *
 * Placement: the value checks (`isString` to `matches`) read `newData` of the
 * node they are placed on, so they go in that node's `.validate`, usually a
 * field node under a record. `shape`, and the constraints `required` it uses,
 * go on the record.
 *
 * `.validate` runs only for the nodes a write carries and their ancestors,
 * against the merged value after the write, and never for a node whose new
 * value is null. So a field's check runs when the field is written, the
 * record's `required` runs for every write inside the record, and
 * neither runs on a delete.
 */
import type { Expr, PathDef } from '../constraints/types.js';
import { all, any, expr, lit, type Literal } from '../constraints/compose.js';
import { eq, newDataIs, newDataVal } from '../constraints/data.js';
import { required } from '../constraints/policies.js';
import { fieldName, finite } from './expr.js';

/** The written value is a string. Field node `.validate`. */
export const isString = (): Expr => newDataIs('String');

/** The written value is a number. Field node `.validate`. */
export const isNumber = (): Expr => newDataIs('Number');

/** The written value is a boolean. Field node `.validate`. */
export const isBoolean = (): Expr => newDataIs('Boolean');

/** The written value is a string of `min` to `max` characters. Field node `.validate`. */
export function stringLength(min: number, max: number): Expr {
  finite('stringLength', 'min', min);
  finite('stringLength', 'max', max);
  if (min > max) throw new Error(`stringLength: min ${min} is greater than max ${max}.`);
  return all(isString(), expr(`newData.val().length >= ${lit(min)}`), expr(`newData.val().length <= ${lit(max)}`));
}

/** The written value is a number from `min` to `max`, inclusive. Field node `.validate`. */
export function numberBetween(min: number, max: number): Expr {
  finite('numberBetween', 'min', min);
  finite('numberBetween', 'max', max);
  if (min > max) throw new Error(`numberBetween: min ${min} is greater than max ${max}.`);
  return all(isNumber(), expr(`newData.val() >= ${lit(min)}`), expr(`newData.val() <= ${lit(max)}`));
}

/**
 * The written value equals one of `values`. Comparison does not convert
 * types, so `oneOf(1)` refuses the string '1'. Field node `.validate`.
 */
export function oneOf(...values: Literal[]): Expr {
  if (values.length === 0) throw new Error('oneOf: pass at least one value.');
  return any(...values.map((value) => eq(newDataVal(), value)));
}

/**
 * The written value is a string that matches the regular expression
 * `pattern`, written without slashes. RTDB matches the pattern anywhere in the
 * string unless it is anchored with ^ and $. Field node `.validate`.
 */
export function matches(pattern: string): Expr {
  if (typeof pattern !== 'string' || pattern.length === 0) throw new Error('matches: pass a non-empty pattern.');
  if (/(^|[^\\])\//.test(pattern)) throw new Error(`matches: escape '/' in the pattern as '\\/': ${pattern}`);
  return all(isString(), expr(`newData.val().matches(/${pattern}/)`));
}

/** A field's rule in {@link shape}: a type name, an expression for its `.validate`, or a full path definition. */
export type FieldRule = 'string' | 'number' | 'boolean' | Expr | PathDef;

export interface ShapeOptions {
  /** Fields the record must have. Defaults to every field in the spec. */
  required?: string[];
  /** Leave children outside the spec unchecked. Defaults to false: any other child is refused. */
  open?: boolean;
}

export interface ShapeResult {
  validate?: Expr;
  children: Record<string, PathDef>;
}

function fieldDef(rule: FieldRule): PathDef {
  if (rule === 'string') return { validate: isString() };
  if (rule === 'number') return { validate: isNumber() };
  if (rule === 'boolean') return { validate: isBoolean() };
  if (typeof rule === 'string') return { validate: rule };
  return rule;
}

/**
 * The closed shape of a record: `validate` requires the required fields, and
 * `children` gives each field its rule and refuses any other child through a
 * `$other` wildcard whose `.validate` is false. Spread the result into the
 * record's path definition; to add a record check, write
 * `validate: all(result.validate, check)`.
 */
export function shape(spec: Record<string, FieldRule>, options: ShapeOptions = {}): ShapeResult {
  const names = Object.keys(spec);
  if (names.length === 0) throw new Error('shape: pass at least one field.');
  for (const name of names) fieldName('shape', name);
  const requiredNames = options.required ?? names;
  for (const name of requiredNames) {
    if (!names.includes(name)) throw new Error(`shape: required field '${name}' is not in the spec.`);
  }
  const children: Record<string, PathDef> = {};
  for (const name of names) children[`/${name}`] = fieldDef(spec[name]!);
  if (!options.open) children['/$other'] = { validate: expr('false') };
  return requiredNames.length > 0 ? { validate: required(...requiredNames), children } : { children };
}
