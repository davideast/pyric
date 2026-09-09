/**
 * The method table and the argument validator behind the `sdk-service` variant.
 *
 * The variant renders one tool per Firebase service whose discriminator is the
 * SDK's own method name and whose arguments carry the SDK's own argument names.
 * A top-level schema that open-ended buys nothing from the client's schema
 * checker, so the checking that a per-method schema would have done happens
 * here instead, and it goes further: an argument named the way a neighbouring
 * SDK spells it, a document path with the wrong segment parity, or a query whose
 * first ordering does not match its inequality are all rejected before any
 * handler runs, with a message that names the rule and the edit.
 *
 * Each service's methods live in `sdk-validator/<service>.ts`. This module owns
 * the shapes they share, the failure format, and the entry points the renderer
 * calls.
 */
import type { z } from 'zod';

/** Arguments as they arrive from a client. */
export type Args = Record<string, unknown>;

/** The failure a rejected call returns, in the operation result shape. */
export interface InvalidArguments {
  ok: false;
  summary: string;
  data: {
    code: 'invalid_arguments';
    tool: string;
    method: string;
    field?: string;
    fix: string;
  };
}

/** Build one rejection for a known tool and method. */
export type Fail = (body: string, fix: string, field?: string) => InvalidArguments;

/** One SDK method on one service tool. */
export interface MethodSpec {
  /** The name the SDK gives this method. */
  name: string;
  /** The SDK call signature, for the tool description and for `describe`. */
  signature: string;
  /** One sentence an agent reads to choose this method. */
  summary: string;
  /** The arguments, under the SDK's own names. */
  args: z.ZodObject<z.ZodRawShape>;
  /** Every canonical operation this method can reach. */
  operations: readonly string[];
  /** Argument names from a neighbouring API, mapped to the SDK's name. */
  renames?: Readonly<Record<string, string>>;
  /** One example `args` object, shown by `describe`. */
  example: Args;
  /** The canonical operation these arguments reach. */
  resolve(args: Args): string;
  /** The canonical operation's arguments, built from the SDK's. */
  translate(args: Args): Args;
  /** Rules a schema cannot state. Returns a rejection or null. */
  check?(args: Args, fail: Fail): InvalidArguments | null;
}

/** One service tool. */
export interface ToolSpec {
  /** The tool name, which is the service name. */
  name: string;
  /** The opening sentences of the tool description, before the method list. */
  intro: string;
  methods: readonly MethodSpec[];
}

/** The method every tool carries for reading one method's schema. */
export const DESCRIBE_METHOD = 'describe';

/** Levenshtein distance, for suggesting the name that was meant. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min(previous[j] + 1, row[j - 1] + 1, substitution));
    }
    previous = row;
  }
  return previous[b.length];
}

/**
 * The closest candidate, or null when nothing is close enough to name. The
 * budget scales with the longer of the two names rather than the input, so that
 * `setDocument` still finds `setDoc`: a name lengthened by a whole word is the
 * common miss, and it is further away by edit distance than a typo is.
 */
export function closest(input: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase());
    const budget = Math.max(3, Math.ceil(Math.max(input.length, candidate.length) / 2));
    if (distance < bestDistance && distance <= budget) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** Quote a value the way a message shows it back to the caller. */
export function quoted(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (value === undefined) return 'missing';
  return `'${JSON.stringify(value)}'`;
}

/** A rejection builder bound to one tool and method. */
export function failFor(tool: string, method: string): Fail {
  return (body, fix, field) => {
    const data: InvalidArguments['data'] = { code: 'invalid_arguments', tool, method, fix };
    if (field !== undefined) data.field = field;
    return { ok: false, summary: `${tool}.${method}: ${body} ${fix}`, data };
  };
}

/** The names one method's schema declares. */
export function argumentNames(method: MethodSpec): string[] {
  return Object.keys(method.args.shape);
}

/** The name a Zod issue points at, as the caller wrote it. */
function fieldPath(path: readonly (string | number)[]): string {
  return path.map((segment) => String(segment)).join('.');
}

/** The description a method's schema carries for one argument, lowercased for a sentence. */
function argumentSummary(method: MethodSpec, name: string): string {
  const described = (method.args.shape as Record<string, { description?: string }>)[name];
  const text = described?.description;
  if (text === undefined) return '';
  return ` ${text}`;
}

/**
 * Reject an argument name the schema does not declare, preferring a known
 * rename over a spelling guess, because a name borrowed from a neighbouring API
 * is a different mistake from a typo and takes a different correction.
 */
function checkArgumentNames(method: MethodSpec, args: Args, fail: Fail): InvalidArguments | null {
  const known = argumentNames(method);
  for (const name of Object.keys(args)) {
    if (known.includes(name)) continue;
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
  return null;
}

/** Turn the first Zod issue into a message that states the signature and the edit. */
function fromZodIssue(
  method: MethodSpec,
  issue: z.ZodIssue,
  fail: Fail,
  args: Args,
): InvalidArguments {
  const field = fieldPath(issue.path);
  const root = String(issue.path[0] ?? '');
  const detail = argumentSummary(method, root);
  if (issue.code === 'invalid_type' && issue.received === 'undefined') {
    return fail(
      `argument '${field}' is missing. The SDK signature is ${method.signature}.`,
      `Pass '${field}'.${detail}`,
      field,
    );
  }
  if (issue.code === 'invalid_type') {
    return fail(
      `argument '${field}' is ${issue.received}, not ${issue.expected}. The SDK signature is ${method.signature}.`,
      `Pass '${field}' as ${issue.expected}.${detail}`,
      field,
    );
  }
  const shown = quoted(field === '' ? args : undefined);
  return fail(
    `argument '${field}' is invalid: ${issue.message}. The SDK signature is ${method.signature}.`,
    `Correct '${field}' and call again.${detail === '' ? ` Received ${shown}.` : detail}`,
    field,
  );
}

/**
 * Check one call's arguments. Returns null when the call may run, or the
 * rejection the caller is handed instead of a handler's result.
 */
export function validateArguments(
  tool: ToolSpec,
  method: MethodSpec,
  args: Args,
): InvalidArguments | null {
  const fail = failFor(tool.name, method.name);
  const named = checkArgumentNames(method, args, fail);
  if (named !== null) return named;
  const parsed = method.args.safeParse(args);
  if (!parsed.success) return fromZodIssue(method, parsed.error.issues[0], fail, args);
  return method.check?.(args, fail) ?? null;
}

/** Reject a method name the tool does not carry, suggesting the closest one. */
export function validateMethodName(tool: ToolSpec, method: unknown): InvalidArguments | null {
  const names = [...tool.methods.map((candidate) => candidate.name), DESCRIBE_METHOD];
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
