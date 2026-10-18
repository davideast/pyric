/**
 * The `rules` tool's argument vocabulary.
 *
 * Rules have no client SDK, so the method names are the ones the tooling uses
 * rather than a library's. The `service` argument is what makes one lint or one
 * simulate reach three canonical operations, and it is required, because a
 * rules call that guesses its service would silently evaluate the wrong ruleset
 * and report a confident answer about a file nobody asked about.
 *
 * Every service-specific fact is read from that service's engine record: which
 * services exist, which request methods each one evaluates, and whether a
 * source parses for it. Nothing about a service is spelled twice.
 */
import { z } from 'zod';
import { RULES_SERVICES, rulesEngineFor } from '../rules-engines/registry.js';
import type { Args, Fail, InvalidArguments } from '../method-types.js';
import { quoted } from '../closest-name.js';
import { checkInstant } from './instants.js';

/** Reject a `requestTime` that does not parse as a date. */
export function checkRequestTime(args: Args, fail: Fail): InvalidArguments | null {
  return checkInstant('requestTime', args, fail);
}

/** The services that carry Security Rules, from the engine records. */
export const SERVICES: readonly string[] = RULES_SERVICES;

export const RENAMES: Readonly<Record<string, string>> = {
  product: 'service',
  source: 'rules',
  rulesSource: 'rules',
  method: 'operation',
  op: 'operation',
};

/**
 * The `service` argument, whose values are the engine record names. Zod takes
 * a literal tuple, and the record set is read at load time, so the widening
 * cast is how a derived list reaches an enum.
 */
export const service = z
  .enum(SERVICES as [string, ...string[]])
  .describe(`The service whose rules are read: ${SERVICES.join(', ')}.`);

/**
 * Every request method any service evaluates. A call names one service, and
 * `checkOperation` narrows this to the methods that service evaluates; the
 * enum is the wider set so the values are all spelled before the first call.
 */
export const REQUEST_METHODS: readonly string[] = [
  ...new Set(SERVICES.flatMap((name) => rulesEngineFor(name).requestMethods)),
];

/** The `operation` argument: the request method a simulation evaluates. */
export const operation = z
  .enum(REQUEST_METHODS as [string, ...string[]])
  .describe(`The request method to evaluate: ${REQUEST_METHODS.join(', ')}.`);

/** The path a request targets, in one case and in the single-case form alike. */
export const path = z.string().describe('The path the request targets.');

/** The identity a request runs as, in one case and in the single-case form alike. */
export const uid = z
  .string()
  .describe('Act as this user. Omit to use the held identity.');

/**
 * The value a write carries, in one case and in the single-case form alike.
 * Firestore takes an object. Database takes any JSON value, so `5` or `true`
 * is a scalar write, and an `update` takes the patch keyed by the paths it
 * writes.
 */
export const data = z
  .union([z.record(z.unknown()), z.array(z.unknown()), z.string(), z.number(), z.boolean(), z.null()])
  .describe(
    'The value being written. Firestore takes an object. Database takes any JSON value, such as 5 or true. For a database update, an object keyed by the paths written, relative to path.',
  );

const queryBound = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** The query a database read carries, as rules read it through `query.*`. */
const databaseQuery = z
  .object({
    orderByChild: z.string().optional(),
    orderByKey: z.literal(true).optional(),
    orderByValue: z.literal(true).optional(),
    equalTo: queryBound.optional(),
    startAt: queryBound.optional(),
    endAt: queryBound.optional(),
    limitToFirst: z.number().int().positive().optional(),
    limitToLast: z.number().int().positive().optional(),
  })
  .strict();

const firestoreWhereClause = z
  .object({
    field: z.string(),
    op: z.string(),
    value: z.union([queryBound, z.array(queryBound)]),
  })
  .strict();

/**
 * The query a Firestore `list` carries, as rules read it through
 * `request.query.*` and as static query-proof checks `where` constraints (#371).
 * Mirrors the simulator's `ListQuerySchema`. `where` is typed as `z.array(z.unknown())`
 * in the outer JSON Schema to keep `cases[].query` within the two-object-level
 * argument depth budget, while `checkRequestShape` validates each clause with
 * `firestoreWhereClause`.
 */
const firestoreQuery = z
  .object({
    where: z
      .array(z.unknown())
      .optional()
      .describe('Where clauses as { field, op, value } objects.'),
    limit: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
    orderBy: z.string().optional(),
  })
  .strict();

/** The member names only a Firestore list query carries. */
const FIRESTORE_QUERY_KEYS = new Set(Object.keys(firestoreQuery.shape));

/** Whether a query names only Firestore list members. */
function isFirestoreQuery(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => FIRESTORE_QUERY_KEYS.has(key));
}

/** Whether a query names only database read members. */
function isDatabaseQuery(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => key in databaseQuery.shape);
}

/** The query a request carries: a database read's, or a Firestore list's. */
export const query = z
  .union([databaseQuery, firestoreQuery])
  .describe(
    "The query a read carries, so query rule expressions evaluate. For a database read (query.*): one of orderByChild, orderByKey or orderByValue, with equalTo, startAt, endAt, limitToFirst or limitToLast. For a Firestore list (request.query.* and static query proof): where, limit, offset and orderBy.",
  );

/**
 * Refuse a value or a query the named service has no request for.
 *
 * Firestore evaluates documents, so its `data` is an object. A database read
 * carries a database query, and a Firestore list carries a list query
 * (`limit`, `offset`, `orderBy`); nothing else carries one.
 */
export function checkRequestShape(args: Args, fail: Fail): InvalidArguments | null {
  const service = String(args.service);
  const requests: Array<{ source: Args; field: string; operation: unknown }> = Array.isArray(args.cases)
    ? args.cases.map((one, index) => ({
        source: one as Args,
        field: `cases[${index}]`,
        operation: (one as Args | null)?.operation,
      }))
    : [{ source: args, field: '', operation: args.operation }];
  for (const { source, field, operation } of requests) {
    const at = (name: string) => (field === '' ? name : `${field}.${name}`);
    const value = source.data;
    if (service !== 'database' && value !== undefined) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return fail(
          `data must be an object for ${service} rules. A scalar value is a Realtime Database write.`,
          `Pass data as an object, or use service 'database'.`,
          at('data'),
        );
      }
    }
    if (source.query !== undefined) {
      if (service === 'firestore') {
        // Firestore rules read `request.query` on a list only (FS-CON-3).
        if (operation !== 'list') {
          return fail(
            `query applies to a Firestore list, and this request is ${quoted(operation)}.`,
            `Pass operation 'list', or drop query.`,
            at('query'),
          );
        }
        if (!isFirestoreQuery(source.query)) {
          return fail(
            'query on a Firestore list takes where, limit, offset and orderBy (request.query.*). This one is a Realtime Database query.',
            `Pass query as { where, limit, offset, orderBy }, or use service 'database'.`,
            at('query'),
          );
        }
        const whereList = (source.query as { where?: unknown }).where;
        if (Array.isArray(whereList)) {
          for (const [clauseIndex, clause] of whereList.entries()) {
            if (!firestoreWhereClause.safeParse(clause).success) {
              return fail(
                'each query.where entry on a Firestore list must be an object { field, op, value }.',
                `Pass query.where[${clauseIndex}] as { field: '<field>', op: '==', value: <scalar or array> }.`,
                at(`query.where[${clauseIndex}]`),
              );
            }
          }
        }
        continue;
      }
      if (service !== 'database') {
        return fail(
          `query applies to Realtime Database reads and Firestore lists, and ${service} rules read no query.`,
          `Drop query, or use service 'database' or 'firestore'.`,
          at('query'),
        );
      }
      if (operation !== 'read') {
        return fail(
          `query applies to a read, and this request is ${quoted(operation)}.`,
          `Pass operation 'read', or drop query.`,
          at('query'),
        );
      }
      if (!isDatabaseQuery(source.query)) {
        return fail(
          'query on a database read takes orderByChild, orderByKey or orderByValue with equalTo, startAt, endAt, limitToFirst or limitToLast. This one is a Firestore list query.',
          `Pass a database query, or use service 'firestore' with operation 'list'.`,
          at('query'),
        );
      }
    }
  }
  return null;
}

/**
 * One request to evaluate.
 *
 * The single-case form spells these fields at the top level and `cases` holds
 * an array of them, and both read the same declarations, so a field added to
 * one form is a field of both by construction.
 */
export const simulationCase = z
  .object({
    operation,
    path,
    uid: uid.optional(),
    data: data.optional(),
    query: query.optional(),
    requestTime: z
      .string()
      .optional()
      .describe('ISO 8601 instant this case evaluates at. Defaults to the call-level requestTime, then the sandbox clock.'),
  })
  .describe('One request: the method, the path, the identity, the value, the query, and the instant.');

/** The batch form: one array entry per request to evaluate, answered in order. */
export const cases = z
  .array(simulationCase)
  .optional()
  .describe('Many requests, each answered in order with its own verdict.');

/**
 * Refuse a call that names neither form or both.
 *
 * A call that names `cases` beside a top-level `path` is two questions in one
 * argument set, and answering either of them would be a guess at which the
 * caller meant.
 */
export function checkOneForm(args: Args, fail: Fail): InvalidArguments | null {
  const namesBatch = Array.isArray(args.cases);
  const namesSingle = args.path !== undefined || args.operation !== undefined;
  if (namesBatch && !namesSingle) return null;
  if (namesSingle && !namesBatch) return null;
  if (namesBatch) {
    return fail(
      "a call names either one request, through 'operation' and 'path', or many, through 'cases'. This call names both.",
      "Drop 'cases', or drop 'operation' and 'path'.",
      'cases',
    );
  }
  return fail(
    "a call names either one request, through 'operation' and 'path', or many, through 'cases'. This call names neither.",
    "Pass 'operation' and 'path', or pass 'cases'.",
    'cases',
  );
}

/** The request methods one service evaluates. */
export function requestMethodsOf(name: string): readonly string[] {
  return rulesEngineFor(name).requestMethods;
}

/** The `operation` argument narrowed to one service's own request methods. */
export function requestMethodOf(name: string) {
  const methods = requestMethodsOf(name);
  return z.enum(methods as unknown as [string, ...string[]]);
}

/** Reject a request method the named service does not evaluate. */
export function checkOperation(args: Args, fail: Fail): InvalidArguments | null {
  const service = String(args.service);
  const allowed = rulesEngineFor(service).requestMethods;

  if (Array.isArray(args.cases)) {
    for (const [index, one] of args.cases.entries()) {
      const value = (one as { operation?: unknown } | null)?.operation;
      if (typeof value === 'string' && allowed.includes(value)) continue;
      return unevaluatedMethod(fail, service, allowed, value, `cases[${index}].operation`);
    }
    return null;
  }

  const value = args.operation;
  if (typeof value === 'string' && allowed.includes(value)) return null;
  return unevaluatedMethod(fail, service, allowed, value, 'operation');
}

/** The refusal a request method outside a service's own set draws. */
function unevaluatedMethod(
  fail: Fail,
  service: string,
  allowed: readonly string[],
  value: unknown,
  field: string,
): InvalidArguments {
  return fail(
    `operation ${quoted(value)} is not a request method ${service} rules evaluate. That service evaluates ${allowed.join(', ')}.`,
    `Pass operation as one of ${allowed.join(', ')}.`,
    field,
  );
}

/** Reject a rules source that does not parse, or does not compile, for the named service. */
export function checkRulesCompile(args: Args, fail: Fail): InvalidArguments | null {
  const problem = rulesEngineFor(String(args.service)).compileFailure(String(args.rules ?? ''));
  if (problem === null) return null;
  return fail(problem.body, problem.fix, 'rules');
}
