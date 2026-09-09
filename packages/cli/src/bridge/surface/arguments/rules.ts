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
import { quoted } from '../method-validation.js';

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
  const allowed = rulesEngineFor(String(args.service)).requestMethods;
  const value = args.operation;
  if (typeof value === 'string' && allowed.includes(value)) return null;
  return fail(
    `operation ${quoted(value)} is not a request method ${String(args.service)} rules evaluate. That service evaluates ${allowed.join(', ')}.`,
    `Pass operation as one of ${allowed.join(', ')}.`,
    'operation',
  );
}

/** Reject a rules source that does not parse for the named service. */
export function checkRulesParse(args: Args, fail: Fail): InvalidArguments | null {
  const problem = rulesEngineFor(String(args.service)).parseFailure(String(args.rules ?? ''));
  if (problem === null) return null;
  return fail(problem.body, problem.fix, 'rules');
}
