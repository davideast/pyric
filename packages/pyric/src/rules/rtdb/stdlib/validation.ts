/**
 * `validation`: the type and value of a written node, and the closed shape of
 * a record.
 *
 * Placement: the value checks (`isString` to `matches`) read `newData` of the
 * node they are placed on, so they go in that node's `.validate`, usually a
 * field node under a record. `requiredFields` and `shape` go on the record.
 *
 * `.validate` runs only for the nodes a write carries and their ancestors,
 * against the merged value after the write, and never for a node whose new
 * value is null. So a field's check runs when the field is written, the
 * record's `requiredFields` runs for every write inside the record, and
 * neither runs on a delete.
 */
import type { Expr, PathDef } from '../constraints/types.js';
import { and, fieldName, finite, lit, or, raw, type Literal } from './expr.js';

/** The written value is a string. Field node `.validate`. */
export const isString = (): Expr => raw('newData.isString()');

/** The written value is a number. Field node `.validate`. */
export const isNumber = (): Expr => raw('newData.isNumber()');

/** The written value is a boolean. Field node `.validate`. */
export const isBoolean = (): Expr => raw('newData.isBoolean()');

/** The written value is a string of `min` to `max` characters. Field node `.validate`. */
export function stringLength(min: number, max: number): Expr {
  finite('stringLength', 'min', min);
  finite('stringLength', 'max', max);
  if (min > max) throw new Error(`stringLength: min ${min} is greater than max ${max}.`);
  return and(isString(), raw(`newData.val().length >= ${lit(min)}`), raw(`newData.val().length <= ${lit(max)}`));
}

/** The written value is a number from `min` to `max`, inclusive. Field node `.validate`. */
export function numberBetween(min: number, max: number): Expr {
  finite('numberBetween', 'min', min);
  finite('numberBetween', 'max', max);
  if (min > max) throw new Error(`numberBetween: min ${min} is greater than max ${max}.`);
  return and(isNumber(), raw(`newData.val() >= ${lit(min)}`), raw(`newData.val() <= ${lit(max)}`));
}

/**
 * The written value equals one of `values`. Comparison does not convert
 * types, so `oneOf(1)` refuses the string '1'. Field node `.validate`.
 */
export function oneOf(...values: Literal[]): Expr {
  if (values.length === 0) throw new Error('oneOf: pass at least one value.');
  return or(...values.map((value) => raw(`newData.val() == ${lit(value)}`)));
}

/**
 * The written value is a string that matches the regular expression
 * `pattern`, written without slashes. RTDB matches the pattern anywhere in the
 * string unless it is anchored with ^ and $. Field node `.validate`.
 */
export function matches(pattern: string): Expr {
  if (typeof pattern !== 'string' || pattern.length === 0) throw new Error('matches: pass a non-empty pattern.');
  if (/(^|[^\\])\//.test(pattern)) throw new Error(`matches: escape '/' in the pattern as '\\/': ${pattern}`);
  return and(isString(), raw(`newData.val().matches(/${pattern}/)`));
}

/** The record has every listed child. Record node `.validate`. */
export function requiredFields(...fields: string[]): Expr {
  if (fields.length === 0) throw new Error('requiredFields: pass at least one field.');
  return raw(`newData.hasChildren([${fields.map((f) => lit(fieldName('requiredFields', f))).join(', ')}])`);
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
  const required = options.required ?? names;
  for (const name of required) {
    if (!names.includes(name)) throw new Error(`shape: required field '${name}' is not in the spec.`);
  }
  const children: Record<string, PathDef> = {};
  for (const name of names) children[`/${name}`] = fieldDef(spec[name]!);
  if (!options.open) children['/$other'] = { validate: raw('false') };
  return required.length > 0 ? { validate: requiredFields(...required), children } : { children };
}
