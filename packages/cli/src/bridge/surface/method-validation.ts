/**
 * The argument validator every service-tool call passes through.
 *
 * The service tools discriminate on the SDK's own method name and carry the
 * SDK's own argument names under an open `args` object. A top-level schema that
 * open-ended buys nothing from the client's schema checker, so the checking a
 * per-method schema would have done happens here instead, and it goes further:
 * an argument named the way a neighbouring SDK spells it, a document path with
 * the wrong segment parity, or a query whose first ordering does not match its
 * inequality are all rejected before any handler runs, with a message that
 * names the rule and the edit.
 *
 * The rules a schema cannot state live on the record, as `validate`. This
 * module owns the shared failure format and the two entry points a renderer
 * calls: one for the method name, one for the arguments.
 */
import { z } from 'zod';
import { closest, quoted } from './closest-name.js';
import { refuseUnconfirmed, refuseUnmountedProduction } from './method-effects.js';
import type { Args, Fail, InvalidArguments, Method, Tool } from './method-types.js';

/** The method every tool carries for reading one method's schema. */
export const DESCRIBE_METHOD = 'describe';

/** A rejection builder bound to one tool and method. */
export function failFor(tool: string, method: string): Fail {
  return (body, fix, field, code = 'invalid_arguments') => {
    const data: InvalidArguments['data'] = { code, tool, method, fix };
    if (field !== undefined) data.field = field;
    return { ok: false, summary: `${tool}.${method}: ${body} ${fix}`, data };
  };
}

/** The names one method's schema declares. */
export function argumentNames(method: Method): string[] {
  return Object.keys(method.args.shape);
}

/** The name a Zod issue points at, as the caller wrote it. */
function fieldPath(path: readonly PropertyKey[]): string {
  return path.map((segment) => String(segment)).join('.');
}

/** The description a method's schema carries for one argument, lowercased for a sentence. */
function argumentSummary(method: Method, name: string): string {
  const described = (method.args.shape as Record<string, { description?: string }>)[name];
  const text = described?.description;
  if (text === undefined) return '';
  return ` ${text}`;
}

/**
 * The method's own answer for one argument name, when it has one.
 *
 * `validate` is where a record states the rules a schema cannot, and an
 * argument name is one of them: a name that asks for the opposite of what the
 * method already does is neither a rename nor a typo, and only the record can
 * say so. The answer counts as the method's own when it points at the name
 * being checked, so a rule about some other argument does not pre-empt the
 * unknown-name message the caller needs.
 */
function methodAnswerFor(
  method: Method,
  args: Args,
  field: string,
  unindexedField: string,
  fail: Fail,
): InvalidArguments | null {
  const answered = method.validate?.(args, { fail }) ?? null;
  if (answered === null) return null;
  if (answered.data.field === field || answered.data.field === unindexedField) {
    return answered;
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface ZodDefLike {
  type?: string;
  innerType?: z.ZodTypeAny;
  in?: z.ZodTypeAny;
  catchall?: z.ZodTypeAny;
  element?: z.ZodTypeAny;
  valueType?: z.ZodTypeAny;
  options?: z.ZodTypeAny[];
}

function definitionOf(schema: z.ZodTypeAny): ZodDefLike {
  return schema._zod.def as unknown as ZodDefLike;
}

function isPassthroughObject(def: ZodDefLike): boolean {
  if (def.catchall === undefined) return false;
  const catchallType = definitionOf(def.catchall).type;
  return catchallType === 'unknown' || catchallType === 'any';
}

/** Peel optional, nullable, default, readonly, catch, and pipe wrappers off a schema. */
function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  for (;;) {
    const def = definitionOf(current);
    const hasInnerType =
      def.type === 'optional'
      || def.type === 'nullable'
      || def.type === 'default'
      || def.type === 'readonly'
      || def.type === 'catch';
    if (hasInnerType && def.innerType !== undefined) {
      current = def.innerType;
      continue;
    }
    if (def.type === 'pipe' && def.in !== undefined) {
      current = def.in;
      continue;
    }
    return current;
  }
}

function unknownNestedKeyFailure(
  path: readonly (string | number)[],
  name: string,
  known: readonly string[],
  fail: Fail,
): InvalidArguments {
  const fullField = fieldPath([...path, name]);
  const container = fieldPath(path);
  const suggestion = closest(name, known);
  if (suggestion !== null) {
    return fail(
      `unknown argument ${quoted(fullField)}. '${container}' names this field '${suggestion}'.`,
      `Pass '${container}.${suggestion}' instead of '${fullField}'.`,
      fullField,
    );
  }
  if (known.length === 0) {
    return fail(
      `unknown argument ${quoted(fullField)}. '${container}' accepts no fields.`,
      `Remove '${fullField}'.`,
      fullField,
    );
  }
  return fail(
    `unknown argument ${quoted(fullField)}. '${container}' accepts ${known.join(', ')}.`,
    `Remove '${fullField}'.`,
    fullField,
  );
}

/**
 * Reject an argument name the schema does not declare, at the top level and
 * inside nested object and array schemas, preferring the method's own answer
 * over a rename and a rename over a spelling guess. Freeform record maps
 * (`z.record(...)`) and open (`z.unknown()`) values keep arbitrary user keys.
 */
function checkSchemaArgumentNames(
  method: Method,
  rootArgs: Args,
  schema: z.ZodTypeAny,
  value: unknown,
  path: readonly (string | number)[],
  fail: Fail,
): InvalidArguments | null {
  if (value === undefined || value === null) return null;
  const unwrapped = unwrapSchema(schema);
  const def = definitionOf(unwrapped);

  if (def.type === 'object') {
    if (!isPlainRecord(value)) return null;
    if (isPassthroughObject(def)) return null;
    const shape = (unwrapped as z.ZodObject<z.ZodRawShape, z.core.$ZodObjectConfig>).shape;
    const known = Object.keys(shape);
    for (const name of Object.keys(value)) {
      if (known.includes(name)) continue;
      const fullField = fieldPath([...path, name]);
      const stringSegments = path.filter((segment): segment is string => typeof segment === 'string');
      const unindexedField = fieldPath([...stringSegments, name]);
      const answered = methodAnswerFor(method, rootArgs, fullField, unindexedField, fail);
      if (answered !== null) return answered;
      if (path.length === 0) {
        const renamed = method.renames?.[name] ?? closest(name, known);
        if (renamed !== null && renamed !== undefined) {
          return fail(
            `unknown argument ${quoted(name)}. The SDK names this argument '${renamed}'.`,
            `Pass '${renamed}' instead of '${name}'.`,
            name,
          );
        }
        return fail(
          `unknown argument ${quoted(name)}. ${method.signature} accepts ${known.join(', ')}.`,
          `Remove '${name}'.`,
          name,
        );
      }
      return unknownNestedKeyFailure(path, name, known, fail);
    }
    for (const name of Object.keys(value)) {
      const childSchema = (shape as Record<string, z.ZodTypeAny | undefined>)[name];
      if (childSchema === undefined) continue;
      const nested = checkSchemaArgumentNames(
        method,
        rootArgs,
        childSchema,
        value[name],
        [...path, name],
        fail,
      );
      if (nested !== null) return nested;
    }
    return null;
  }

  if (def.type === 'array') {
    if (!Array.isArray(value) || def.element === undefined) return null;
    for (const [index, item] of value.entries()) {
      const nested = checkSchemaArgumentNames(method, rootArgs, def.element, item, [...path, index], fail);
      if (nested !== null) return nested;
    }
    return null;
  }

  if (def.type === 'record') {
    if (!isPlainRecord(value) || def.valueType === undefined) return null;
    for (const [key, item] of Object.entries(value)) {
      const nested = checkSchemaArgumentNames(method, rootArgs, def.valueType, item, [...path, key], fail);
      if (nested !== null) return nested;
    }
    return null;
  }

  if (def.type === 'union' && Array.isArray(def.options)) {
    const unwrappedOptions = def.options.map((option) => unwrapSchema(option));
    if (Array.isArray(value)) {
      const arrayOption = unwrappedOptions.find((option) => definitionOf(option).type === 'array');
      if (arrayOption === undefined) return null;
      return checkSchemaArgumentNames(method, rootArgs, arrayOption, value, path, fail);
    }
    if (!isPlainRecord(value)) return null;
    const allowsArbitraryKeys = unwrappedOptions.some((option) => {
      const kind = definitionOf(option).type;
      return kind === 'record' || kind === 'unknown' || kind === 'any';
    });
    if (allowsArbitraryKeys) return null;
    const objectOptions = unwrappedOptions.filter(
      (option): option is z.ZodObject<z.ZodRawShape, z.core.$ZodObjectConfig> =>
        definitionOf(option).type === 'object',
    );
    if (objectOptions.length === 0) return null;
    if (objectOptions.length === 1) {
      return checkSchemaArgumentNames(method, rootArgs, objectOptions[0], value, path, fail);
    }
    let bestFailure: InvalidArguments | null = null;
    let bestOverlap = -1;
    for (const option of objectOptions) {
      const candidate = checkSchemaArgumentNames(method, rootArgs, option, value, path, fail);
      if (candidate === null) return null;
      const optionKeys = new Set(Object.keys(option.shape));
      let overlap = 0;
      for (const key of Object.keys(value)) {
        if (optionKeys.has(key)) overlap += 1;
      }
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestFailure = candidate;
      }
    }
    return bestFailure;
  }

  return null;
}

function checkArgumentNames(method: Method, args: Args, fail: Fail): InvalidArguments | null {
  return checkSchemaArgumentNames(method, args, method.args, args, [], fail);
}

/** The runtime type name matching Zod's `invalid_type` vocabulary. */
function receivedTypeName(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan';
    return 'number';
  }
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'bigint') return 'bigint';
  if (typeof value === 'symbol') return 'symbol';
  if (typeof value === 'function') return 'function';
  if (value instanceof Date) return 'date';
  if (value instanceof Map) return 'map';
  if (value instanceof Set) return 'set';
  return 'object';
}

/** Turn the first Zod issue into a message that states the signature and the edit. */
function fromZodIssue(
  method: Method,
  issue: z.core.$ZodIssue,
  fail: Fail,
  args: Args,
): InvalidArguments {
  const field = fieldPath(issue.path);
  const root = String(issue.path[0] ?? '');
  const detail = argumentSummary(method, root);
  const receivedValue = valueAt(args, issue.path);
  if (
    field !== ''
    && receivedValue === undefined
    && (issue.code === 'invalid_type' || issue.code === 'invalid_value')
  ) {
    return fail(
      `argument '${field}' is missing. The SDK signature is ${method.signature}.`,
      `Pass '${field}'.${detail}`,
      field,
    );
  }
  if (issue.code === 'invalid_type') {
    const received = receivedTypeName(receivedValue);
    return fail(
      `argument '${field}' is ${received}, not ${issue.expected}. The SDK signature is ${method.signature}.`,
      `Pass '${field}' as ${issue.expected}.${detail}`,
      field,
    );
  }
  // A closed set is spelled in the signature, so a value outside it is
  // answered with the whole set and, when one is close, the value that was
  // probably meant.
  if (issue.code === 'invalid_value' && issue.values.length > 1) {
    if (
      typeof receivedValue !== 'string'
      && issue.values.every((option) => typeof option === 'string')
    ) {
      const expected = issue.values.map((option) => `'${option}'`).join(' | ');
      const received = receivedTypeName(receivedValue);
      return fail(
        `argument '${field}' is ${received}, not ${expected}. The SDK signature is ${method.signature}.`,
        `Pass '${field}' as ${expected}.${detail}`,
        field,
      );
    }
    const values = issue.values.map((option) => String(option));
    const suggestion = typeof receivedValue === 'string' ? closest(receivedValue, values) : null;
    if (suggestion === null) {
      return fail(
        `argument '${field}' is ${quoted(receivedValue)}, which is not one of ${values.join(', ')}. The SDK signature is ${method.signature}.`,
        `Pass '${field}' as one of ${values.join(', ')}.`,
        field,
      );
    }
    return fail(
      `argument '${field}' is ${quoted(receivedValue)}, which is not one of ${values.join(', ')}. The SDK signature is ${method.signature}.`,
      `Pass '${field}' as '${suggestion}'.`,
      field,
    );
  }
  // A rule a schema states as a refinement, such as a name's shape, reaches
  // here. The value is what the caller has to change, so the message quotes it
  // rather than reporting the argument as absent.
  const shown = quoted(field === '' ? args : valueAt(args, issue.path));
  if (field === '') {
    return fail(
      `the arguments are invalid: ${issue.message}. The SDK signature is ${method.signature}.`,
      `Pass arguments the signature accepts. Received ${shown}.`,
      field,
    );
  }
  return fail(
    `argument '${field}' is ${shown}, which is invalid: ${issue.message}. The SDK signature is ${method.signature}.`,
    `Pass '${field}' as a value the rule allows.${detail}`,
    field,
  );
}

/** The value a Zod issue's path points at, as the caller sent it. */
function valueAt(args: Args, path: readonly PropertyKey[]): unknown {
  let value: unknown = args;
  for (const segment of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<PropertyKey, unknown>)[segment];
  }
  return value;
}

/**
 * Check one call's arguments. Returns null when the call may run, or the
 * rejection the caller is handed instead of a handler's result.
 *
 * `allowProduction` enforces ADR-0014 Decision 5 for a `production` method:
 * absent it defaults to disallowed, which is the safe default every direct
 * caller (a test, a script) gets without naming it. The MCP path and the CLI
 * path both thread the server's actual `--allow-production` state through
 * here rather than re-checking the effect themselves.
 */
export function validateArguments(
  method: Method,
  args: Args,
  allowProduction = false,
): InvalidArguments | null {
  const fail = failFor(method.tool, method.method);
  const unmounted = refuseUnmountedProduction(method, allowProduction, fail);
  if (unmounted !== null) return unmounted;
  const named = checkArgumentNames(method, args, fail);
  if (named !== null) return named;
  const parsed = method.args.safeParse(args);
  if (!parsed.success) return fromZodIssue(method, parsed.error.issues[0], fail, args);
  const unconfirmedDestruction = refuseUnconfirmed('destructive', method, args, fail);
  if (unconfirmedDestruction !== null) return unconfirmedDestruction;
  const unconfirmedProduction = refuseUnconfirmed('production', method, args, fail);
  if (unconfirmedProduction !== null) return unconfirmedProduction;
  return method.validate?.(args, { fail }) ?? null;
}

/** Every name a tool's `method` argument accepts, `describe` last. */
export function methodNames(tool: Tool): string[] {
  return [...tool.methods.map((method) => method.method), DESCRIBE_METHOD];
}

/** Reject a method name the tool does not carry, suggesting the closest one. */
export function validateMethodName(tool: Tool, method: unknown): InvalidArguments | null {
  const names = methodNames(tool);
  const fail = failFor(tool.name, typeof method === 'string' ? method : '');
  if (typeof method !== 'string' || method === '') {
    return fail(
      `method is ${quoted(method)}. Every call names one of ${names.join(', ')}.`,
      `Pass method as one of ${names.join(', ')}.`,
      'method',
    );
  }
  if (names.includes(method)) return null;
  const suggestion = closest(method, names);
  const hint = suggestion === null ? '' : ` Did you mean '${suggestion}'?`;
  return fail(
    `no method ${quoted(method)}.${hint} The ${tool.name} tool accepts ${names.join(', ')}.`,
    suggestion === null
      ? `Pass method as one of ${names.join(', ')}.`
      : `Call ${tool.name} with method '${suggestion}'.`,
    'method',
  );
}

/**
 * Check the `args` a `describe` call names. `describe` reads a method's schema,
 * so its own argument is a method name and nothing else.
 */
export function validateDescribe(tool: Tool, args: Args): InvalidArguments | null {
  const fail = failFor(tool.name, DESCRIBE_METHOD);
  const names = tool.methods.map((method) => method.method);
  const named = args.method;
  if (typeof named !== 'string') {
    return fail(
      `args.method is ${quoted(named)}. describe reads one method schema, so it names the method to read.`,
      `Pass args: { method: '${names[0]}' }.`,
      'method',
    );
  }
  if (names.includes(named)) return null;
  return fail(
    `args.method is ${quoted(named)}, which ${tool.name} does not carry. Its methods are ${names.join(', ')}.`,
    `Pass args.method as one of ${names.join(', ')}.`,
    'method',
  );
}
