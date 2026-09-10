/**
 * How a command line spells one method record's arguments.
 *
 * The MCP surface carries arguments as JSON, so an object argument arrives as
 * an object. A command line carries strings, so an object or an array argument
 * arrives as a JSON string and is parsed here against the record's own schema.
 * That difference is the CLI's shape, not the surface's, so it lives here
 * rather than on the record.
 *
 * The same reasoning gives every argument a second spelling. A ruleset, a seed,
 * and a document body are things a project keeps in a file, and a shell that
 * has to inline one loses the newlines a rules source is written with. So any
 * argument written `--<arg>` may instead be written `--<arg>-file <path>`, and
 * the file is read as that argument's own kind: text for a string argument,
 * parsed JSON for an object or array one. The convention is derived from the
 * names a record already declares, so a new record carries it without saying
 * anything, and no record knows the CLI has a filesystem.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { z } from 'zod';
import type { Args, Method } from '../bridge/surface/method-types.js';
import type { ParsedArgs } from './parse-args.js';

/** The suffix that reads an argument from a file rather than from the flag. */
export const FILE_FLAG_SUFFIX = '-file';

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
 * output format, `--in-process` names the sandbox host, and
 * `--allow-production` mounts the production methods. None reaches a handler.
 */
const RESERVED_FLAGS = new Set(['json', 'in-process', 'allow-production']);

/** The flag names one record accepts, in schema order. */
export function flagNames(method: Method): string[] {
  return Object.keys(method.args.shape);
}

/** The argument a `--<arg>-file` flag names, or null when it names none. */
function fileFlagArgument(flag: string, known: readonly string[]): string | null {
  if (!flag.endsWith(FILE_FLAG_SUFFIX)) return null;
  const name = flag.slice(0, -FILE_FLAG_SUFFIX.length);
  if (!known.includes(name)) return null;
  return name;
}

/** Read one argument's value out of the file a `--<arg>-file` flag names. */
function valueFromFile(
  method: Method,
  name: string,
  raw: string | boolean | Array<string | boolean>,
  cwd: string,
): { value: unknown } | { error: string } {
  const kind = argumentKind(method.args.shape[name] as z.ZodTypeAny);
  if (kind !== 'string' && kind !== 'json') {
    return {
      error: `--${name} is a ${kind}, so it has no file form. Pass --${name} <value>.`,
    };
  }
  if (typeof raw !== 'string') {
    return { error: `--${name}${FILE_FLAG_SUFFIX} needs a path. Pass --${name}${FILE_FLAG_SUFFIX} <path>.` };
  }

  let path = raw;
  if (!isAbsolute(raw)) path = resolve(cwd, raw);
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `--${name}${FILE_FLAG_SUFFIX} could not read '${raw}': ${detail}.` };
  }

  if (kind === 'string') return { value: contents };
  try {
    return { value: JSON.parse(contents) as unknown };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `--${name}${FILE_FLAG_SUFFIX} read '${raw}', which is not valid JSON: ${detail}.` };
  }
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
 * silently dropped on the way to the handler, and an argument supplied twice,
 * once inline and once from a file, is refused rather than resolved by order.
 */
export function argumentsFromFlags(
  method: Method,
  parsed: ParsedArgs,
  cwd: string = process.cwd(),
): ArgumentsOrError {
  const known = flagNames(method);
  const args: Args = {};
  for (const [flag, raw] of parsed.flags) {
    if (RESERVED_FLAGS.has(flag)) continue;
    const fromFile = fileFlagArgument(flag, known);
    const name = fromFile ?? flag;
    if (fromFile === null && !known.includes(flag)) {
      return {
        error: `pyric ${method.tool} ${method.method} has no --${flag}. It accepts ${known
          .map((accepted) => `--${accepted}`)
          .join(', ')}, and reads any of them from a file as --<arg>${FILE_FLAG_SUFFIX} <path>.`,
      };
    }
    if (args[name] !== undefined) {
      return {
        error: `--${name} was supplied twice, inline and from a file. Pass one of --${name} and --${name}${FILE_FLAG_SUFFIX}.`,
      };
    }

    let read: { value: unknown } | { error: string };
    if (fromFile === null) {
      read = valueFor(method, name, raw);
    } else {
      read = valueFromFile(method, name, raw, cwd);
    }
    if ('error' in read) return read;
    args[name] = read.value;
  }
  return { args };
}
