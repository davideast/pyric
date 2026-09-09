/**
 * The `rules` tool's argument vocabulary.
 *
 * Rules have no client SDK, so the method names are the ones the tooling uses
 * rather than a library's. The `service` argument is what makes one lint or one
 * simulate reach three canonical operations, and it is required, because a
 * rules call that guesses its service would silently evaluate the wrong ruleset
 * and report a confident answer about a file nobody asked about.
 */
import { z } from 'zod';
import { lintFirestoreRules } from 'pyric/rules/internal';
import { parseStorageRules } from 'pyric/storage';
import type { Args, Fail, InvalidArguments } from '../method-types.js';
import { closest, quoted } from '../method-validation.js';

/** The services that carry Security Rules. */
export const SERVICES = ['firestore', 'database', 'storage'] as const;

/** The request methods each service evaluates, which differ per service. */
const REQUEST_METHODS: Readonly<Record<string, readonly string[]>> = {
  firestore: ['get', 'list', 'create', 'update', 'delete'],
  database: ['read', 'write', 'validate'],
  storage: ['get', 'list', 'create', 'update', 'delete', 'read', 'write'],
};

export const RENAMES: Readonly<Record<string, string>> = {
  product: 'service',
  source: 'rules',
  rulesSource: 'rules',
  method: 'operation',
  op: 'operation',
};

export const service = z
  .string()
  .describe(`The service whose rules are read: ${SERVICES.join(', ')}.`);

/** Reject a service that is not one of the three, suggesting the closest. */
export function checkService(args: Args, fail: Fail): InvalidArguments | null {
  const value = args.service;
  if (typeof value === 'string' && SERVICES.includes(value as never)) return null;
  const suggestion = typeof value === 'string' ? closest(value, [...SERVICES]) : null;
  return fail(
    `service ${quoted(value)} is not a Firebase service with Security Rules. Rules exist for ${SERVICES.join(', ')}.`,
    `Pass service '${suggestion ?? 'firestore'}'.`,
    'service',
  );
}

/** Reject a request method the named service does not evaluate. */
export function checkOperation(args: Args, fail: Fail): InvalidArguments | null {
  const named = checkService(args, fail);
  if (named !== null) return named;
  const allowed = REQUEST_METHODS[String(args.service)];
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
  const named = checkService(args, fail);
  if (named !== null) return named;
  const target = String(args.service);
  const source = String(args.rules ?? '');
  if (target === 'database') {
    try {
      JSON.parse(source);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(
        `rules did not parse as JSON: ${message}.`,
        `Pass rules JSON that parses, then call set again.`,
        'rules',
      );
    }
  }
  if (target === 'storage') {
    try {
      parseStorageRules(source);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(
        `rules did not parse: ${message}.`,
        `Pass a rules source that parses, then call set again.`,
        'rules',
      );
    }
  }
  const lint = lintFirestoreRules(source);
  if (lint.parseError === undefined) return null;
  const parseError = lint.parseError;
  return fail(
    `rules did not parse at line ${parseError.line}, column ${parseError.column}: expected ${parseError.expected}.`,
    `Pass a rules source that parses, then call set again.`,
    'rules',
  );
}
