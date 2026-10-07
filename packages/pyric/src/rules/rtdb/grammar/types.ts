/**
 * The static types of RTDB rule expressions, and the member and operator
 * tables production's rules compiler checks them against.
 *
 * Every table entry and every message is production's: each was captured from
 * the validation request `firebase deploy` makes for database rules
 * (`PUT /.settings/rules.json?dryRun=true`). The capture places one sample of
 * each type in every operand position; the replay test in
 * `test/rules/rtdb/grammar/validator-types.test.ts` holds this file to it.
 */
import type { RuleError } from '../types.js';

/**
 * A static type.
 *
 * - `Snapshot`: `data`, `newData`, `root`, and `child()` or `parent()` of one.
 * - `SnapshotMethod`: a snapshot method read as a property, such as `data.exists`.
 * - `Value`: a stored value of unknown primitive type, from `val()` or
 *   `getPriority()`. Operators accept it; members are a string's.
 * - `Auth`: `auth` and any property or index of it, at any depth. Operators
 *   accept it; any member name is another `Auth`, except a string method.
 * - `Query`: `query`. `QueryValue`: one of its non-flag properties, a primitive
 *   with no members that is not a string argument.
 * - `Mixed`: a ternary whose branches differ in type. Operators and string
 *   arguments accept it; it has no members.
 * - `Error`: an operand that already failed. It satisfies every check, so one
 *   mistake reports one error.
 */
export type RtdbStaticType =
  | 'Boolean'
  | 'Number'
  | 'String'
  | 'Null'
  | 'Regex'
  | 'Array'
  | 'Snapshot'
  | 'SnapshotMethod'
  | 'Value'
  | 'Auth'
  | 'Query'
  | 'QueryValue'
  | 'Mixed'
  | 'Error';

/** A typed expression. An array literal carries its element types for `hasChildren()`. */
export interface RtdbTypedValue {
  type: RtdbStaticType;
  elements?: RtdbStaticType[];
}

const set = (...types: RtdbStaticType[]): ReadonlySet<RtdbStaticType> => new Set<RtdbStaticType>(['Error', ...types]);

/** Operands of `!`, `&&`, `||`, the `?` condition, and the rule itself. */
export const BOOLEAN_OPERANDS = set('Boolean');
/** Operands of `==`, `!=`, `===` and `!==`. */
export const EQUALITY_OPERANDS = set('Boolean', 'Number', 'String', 'Null', 'Value', 'Auth', 'QueryValue', 'Mixed');
/** Operands of `<`, `<=`, `>`, `>=` and `+`. */
export const ORDERING_OPERANDS = set('Number', 'String', 'Value', 'Auth', 'QueryValue', 'Mixed');
/** Operands of binary `-`, `*`, `/`, `%` and unary `-`. */
export const NUMERIC_OPERANDS = set('Number', 'Value', 'Auth', 'QueryValue', 'Mixed');
/** Arguments a string parameter accepts, and `hasChildren()` array elements. */
export const STRING_ARGUMENTS = set('String', 'Value', 'Auth', 'Mixed');

/** The diagnostic for one failed check. */
export function typeError(code: string, message: string): RuleError {
  return { code, message };
}

/** The message for an operand a binary operator does not accept. */
export function operandMessage(operator: string, side: 'left' | 'right'): string {
  switch (operator) {
    case '==':
    case '===':
      return side === 'left'
        ? 'Invalid == expression: left operand is not a number, boolean, string, null.'
        : 'Invalid == expression: right operand is not a number, boolean, string, or null.';
    case '!=':
    case '!==':
      return `Invalid != expression: ${side} operand is not a number, boolean, string, or null.`;
    case '<':
    case '<=':
    case '>':
    case '>=':
      return `Invalid ${operator} expression: ${side} operand must be a number or string.`;
    case '+':
      return `Invalid + expression: ${side} operand is not a number or string.`;
    default:
      return `Invalid ${operator} expression: ${side} operand is not a number.`;
  }
}

/** The operand set a binary operator accepts. */
export function operandsOf(operator: string): ReadonlySet<RtdbStaticType> {
  switch (operator) {
    case '==':
    case '===':
    case '!=':
    case '!==':
      return EQUALITY_OPERANDS;
    case '<':
    case '<=':
    case '>':
    case '>=':
    case '+':
      return ORDERING_OPERANDS;
    default:
      return NUMERIC_OPERANDS;
  }
}

/** The result type of a binary operator whose operands passed their checks. */
export function binaryResult(operator: string, left: RtdbStaticType, right: RtdbStaticType): RtdbStaticType {
  if (operator !== '+' && operator !== '-' && operator !== '*' && operator !== '/' && operator !== '%') return 'Boolean';
  if (left === 'Error' || right === 'Error') return 'Error';
  if (operator !== '+') return 'Number';
  if (left === 'String' || right === 'String') return 'String';
  if (left === 'Number' && right === 'Number') return 'Number';
  return 'Value';
}

/** A method: its result type, and the check its arguments must pass. */
export interface RtdbMethod {
  returns: RtdbStaticType;
  /** The first failed argument check, or null. Array arguments other than `hasChildren()`'s are refused before this runs. */
  check(name: string, args: readonly RtdbTypedValue[]): RuleError | null;
}

function noArguments(returns: RtdbStaticType): RtdbMethod {
  return {
    returns,
    check: (name, args) =>
      args.length === 0 ? null : typeError('WRONG_ARGUMENT_COUNT', `${name}() expects no arguments.`),
  };
}

function oneString(returns: RtdbStaticType): RtdbMethod {
  return {
    returns,
    check(name, args) {
      if (args.length !== 1) return typeError('WRONG_ARGUMENT_COUNT', `${name}() expects 1 argument.`);
      return STRING_ARGUMENTS.has(args[0]!.type)
        ? null
        : typeError('ARGUMENT_TYPE', `${name}() expects a string argument.`);
    },
  };
}

const HAS_CHILDREN: RtdbMethod = {
  returns: 'Boolean',
  check(_name, args) {
    if (args.length === 0) return null;
    if (args.length > 1) {
      return typeError(
        'WRONG_ARGUMENT_COUNT',
        'hasChildren() expects only a single argument (containing an array of child names).',
      );
    }
    const list = args[0]!;
    if (list.type === 'Error') return null;
    if (list.type !== 'Array') return typeError('ARGUMENT_TYPE', 'hasChildren() expects an array of child names.');
    return (list.elements ?? []).every((element) => STRING_ARGUMENTS.has(element))
      ? null
      : typeError('ARGUMENT_TYPE', 'hasChildren() expects an array of strings.');
  },
};

const REPLACE: RtdbMethod = {
  returns: 'String',
  check(_name, args) {
    if (args.length !== 2) return typeError('WRONG_ARGUMENT_COUNT', 'replace() expects two arguments.');
    const failed = args.findIndex((arg) => !STRING_ARGUMENTS.has(arg.type));
    return failed === -1
      ? null
      : typeError('ARGUMENT_TYPE', `Argument ${failed + 1} of replace() must be a string.`);
  },
};

const MATCHES: RtdbMethod = {
  returns: 'Boolean',
  check(_name, args) {
    if (args.length !== 1) {
      return typeError('WRONG_ARGUMENT_COUNT', 'matches() expects 1 regular expression literal argument.');
    }
    const type = args[0]!.type;
    return type === 'Regex' || type === 'Error'
      ? null
      : typeError('ARGUMENT_TYPE', 'matches() expects a regular expression literal argument.');
  },
};

/** Methods of a snapshot. */
export const SNAPSHOT_METHODS: ReadonlyMap<string, RtdbMethod> = new Map([
  ['val', noArguments('Value')],
  ['exists', noArguments('Boolean')],
  ['isString', noArguments('Boolean')],
  ['isNumber', noArguments('Boolean')],
  ['isBoolean', noArguments('Boolean')],
  ['parent', noArguments('Snapshot')],
  ['getPriority', noArguments('Value')],
  ['child', oneString('Snapshot')],
  ['hasChild', oneString('Boolean')],
  ['hasChildren', HAS_CHILDREN],
]);

/** Methods of a string, also callable on a `Value` and an `Auth`. */
export const STRING_METHODS: ReadonlyMap<string, RtdbMethod> = new Map([
  ['contains', oneString('Boolean')],
  ['beginsWith', oneString('Boolean')],
  ['endsWith', oneString('Boolean')],
  ['replace', REPLACE],
  ['toLowerCase', noArguments('String')],
  ['toUpperCase', noArguments('String')],
  ['matches', MATCHES],
]);

/** Properties of `query`. */
export const QUERY_PROPERTIES: ReadonlyMap<string, RtdbStaticType> = new Map([
  ['orderByKey', 'Boolean'],
  ['orderByValue', 'Boolean'],
  ['orderByPriority', 'Boolean'],
  ['orderByChild', 'QueryValue'],
  ['startAt', 'QueryValue'],
  ['endAt', 'QueryValue'],
  ['equalTo', 'QueryValue'],
  ['limitToFirst', 'QueryValue'],
  ['limitToLast', 'QueryValue'],
]);

/** What a member name resolves to on a receiver. */
export type RtdbMember =
  | { kind: 'method'; method: RtdbMethod }
  | { kind: 'property'; type: RtdbStaticType }
  | { kind: 'error'; error: RuleError | null };

const NOT_AN_OBJECT = 'Invalid property access: target is not an object.';

/** Resolve `receiver.name`. An `Error` receiver resolves to an error with nothing to report. */
export function memberOf(receiver: RtdbStaticType, name: string): RtdbMember {
  const noSuchMember = (): RtdbMember => ({
    kind: 'error',
    error: typeError('NO_SUCH_MEMBER', `No such method/property '${name}'.`),
  });
  switch (receiver) {
    case 'Error':
      return { kind: 'error', error: null };
    case 'Snapshot': {
      const method = SNAPSHOT_METHODS.get(name);
      return method ? { kind: 'method', method } : noSuchMember();
    }
    case 'String':
    case 'Value': {
      const method = STRING_METHODS.get(name);
      if (method) return { kind: 'method', method };
      return name === 'length' ? { kind: 'property', type: 'Number' } : noSuchMember();
    }
    case 'Auth': {
      const method = STRING_METHODS.get(name);
      return method ? { kind: 'method', method } : { kind: 'property', type: 'Auth' };
    }
    case 'Query': {
      const type = QUERY_PROPERTIES.get(name);
      return type ? { kind: 'property', type } : noSuchMember();
    }
    default:
      return { kind: 'error', error: typeError('NOT_AN_OBJECT', NOT_AN_OBJECT) };
  }
}

/** The type each root variable has. `newData` is refused in `.read` before this applies. */
export const ROOT_VARIABLES: ReadonlyMap<string, RtdbStaticType> = new Map([
  ['auth', 'Auth'],
  ['data', 'Snapshot'],
  ['newData', 'Snapshot'],
  ['root', 'Snapshot'],
  ['now', 'Number'],
  ['query', 'Query'],
]);
