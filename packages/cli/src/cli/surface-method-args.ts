/**
 * How a command line spells one method record's arguments.
 *
 * The MCP surface carries arguments as JSON, so an object argument arrives as
 * an object. A command line carries strings, so an object or an array argument
 * arrives as a JSON string and is parsed here against the record's own schema.
 * That difference is the CLI's shape, not the surface's, so it lives here
 * rather than on the record.
 */
import type { z } from 'zod';
import type { Args, Method } from '../bridge/surface/method-types.js';
import type { ParsedArgs } from './parse-args.js';

/** What one argument of a record's schema accepts on a command line. */
type ArgumentKind = 'string' | 'number' | 'boolean' | 'json';

/** A parsed command line, or the message explaining why it is not one. */
export type ArgumentsOrError = { args: Args } | { error: string };

/** The innermost schema of a wrapper chain, past optional, nullable, and default. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = schema._def as { typeName: string; innerType?: z.ZodTypeAny };
  if (def.innerType === undefined) return schema;
  if (['ZodOptional', 'ZodNullable', 'ZodDefault'].includes(def.typeName)) {
    return unwrap(def.innerType);
  }
  return schema;
}

/**
 * How one argument is written on a command line. An enum is written as the word
 * itself, the same way the MCP surface carries it, rather than as a quoted JSON
 * string: `--service firestore`, not `--service '"firestore"'`.
 */
export function argumentKind(schema: z.ZodTypeAny): ArgumentKind {
  const typeName = (unwrap(schema)._def as { typeName: string }).typeName;
  if (typeName === 'ZodNumber') return 'number';
  if (typeName === 'ZodBoolean') return 'boolean';
  if (typeName === 'ZodString') return 'string';
  if (typeName === 'ZodEnum') return 'string';
  return 'json';
}

/**
 * Flags the command line owns rather than the record: `--json` selects the
 * output format and reaches no handler.
 */
const RESERVED_FLAGS = new Set(['json']);

/** The flag names one record accepts, in schema order. */
export function flagNames(method: Method): string[] {
  return Object.keys(method.args.shape);
}

/** Read one flag's value, converted to what the schema expects. */
function valueFor(
  method: Method,
  name: string,
  raw: string | boolean | Array<string | boolean>,
): { value: unknown } | { error: string } {
  const kind = argumentKind(method.args.shape[name] as z.ZodTypeAny);
  if (kind === 'boolean') return { value: raw !== 'false' };
  if (Array.isArray(raw)) {
    return { error: `--${name} was passed more than once; pass it once.` };
  }
  if (typeof raw !== 'string') {
    return { error: `--${name} needs a value. Pass --${name} <value>.` };
  }
  if (kind === 'string') return { value: raw };
  if (kind === 'number') {
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return { error: `--${name} is not a number: '${raw}'.` };
    return { value: parsed };
  }
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `--${name} is not valid JSON: ${detail}. Pass it as a JSON string.` };
  }
}

/**
 * The record's arguments, from the flags a command line carried. An unknown
 * flag is refused by name so a mistyped argument fails here rather than being
 * silently dropped on the way to the handler.
 */
export function argumentsFromFlags(method: Method, parsed: ParsedArgs): ArgumentsOrError {
  const known = flagNames(method);
  const args: Args = {};
  for (const [name, raw] of parsed.flags) {
    if (RESERVED_FLAGS.has(name)) continue;
    if (!known.includes(name)) {
      return {
        error: `pyric ${method.tool} ${method.method} has no --${name}. It accepts ${known
          .map((flag) => `--${flag}`)
          .join(', ')}.`,
      };
    }
    const read = valueFor(method, name, raw);
    if ('error' in read) return read;
    args[name] = read.value;
  }
  return { args };
}
