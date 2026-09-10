/**
 * The `rules` tool: Security Rules across the three services that have them.
 *
 * Rules have no client SDK, so the method names here are the ones the tooling
 * uses rather than a library's. The `service` argument is what makes one lint
 * or one simulate reach three canonical operations, and it is required, because
 * a rules call that guesses its service would silently evaluate the wrong
 * ruleset and report a confident answer about a file nobody asked about.
 */
import { z } from 'zod';
import { lintFirestoreRules } from 'pyric/rules/internal';
import { parseStorageRules } from 'pyric/storage';
import type { Args, Fail, InvalidArguments, MethodSpec, ToolSpec } from './shared.js';
import { closest, quoted } from './shared.js';

/** The services that carry Security Rules. */
const SERVICES = ['firestore', 'database', 'storage'] as const;

/** The request methods each service evaluates, which differ per service. */
const OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  firestore: ['get', 'list', 'create', 'update', 'delete'],
  database: ['read', 'write', 'validate'],
  storage: ['get', 'list', 'create', 'update', 'delete', 'read', 'write'],
};

const RENAMES: Readonly<Record<string, string>> = {
  product: 'service',
  source: 'rules',
  rulesSource: 'rules',
  method: 'operation',
  op: 'operation',
};

const service = z
  .string()
  .describe(`The service whose rules are read: ${SERVICES.join(', ')}.`);

/** Reject a service that is not one of the three, suggesting the closest. */
function checkService(args: Args, fail: Fail): InvalidArguments | null {
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
function checkOperation(args: Args, fail: Fail): InvalidArguments | null {
  const named = checkService(args, fail);
  if (named !== null) return named;
  const allowed = OPERATIONS[String(args.service)];
  const value = args.operation;
  if (typeof value === 'string' && allowed.includes(value)) return null;
  return fail(
    `operation ${quoted(value)} is not a request method ${String(args.service)} rules evaluate. That service evaluates ${allowed.join(', ')}.`,
    `Pass operation as one of ${allowed.join(', ')}.`,
    'operation',
  );
}

/** Reject a rules source that does not parse for the named service, in the validator's fix format. */
function checkRulesParse(args: Args, fail: Fail): InvalidArguments | null {
  const named = checkService(args, fail);
  if (named !== null) return named;
  const service = String(args.service);
  const source = String(args.rules ?? '');
  if (service === 'database') {
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
  if (service === 'storage') {
    try {
      parseStorageRules(source);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`rules did not parse: ${message}.`, `Pass a rules source that parses, then call set again.`, 'rules');
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

const METHODS: readonly MethodSpec[] = [
  {
    name: 'lint',
    sdkOrigin: 'pyric',
    signature: 'lint(service, rules?)',
    summary: 'Check a ruleset for errors without evaluating a request.',
    args: z.object({
      service,
      rules: z
        .string()
        .optional()
        .describe('Rules source to lint. Defaults to the rules the sandbox is running.'),
    }),
    operations: ['lint_firestore_rules', 'lint_database_rules', 'lint_storage_rules'],
    renames: RENAMES,
    example: { service: 'firestore' },
    resolve: (args) => `lint_${String(args.service)}_rules`,
    translate: (args) => (args.rules === undefined ? {} : { rules: args.rules }),
    check: checkService,
  },
  {
    name: 'simulate',
    sdkOrigin: 'pyric',
    signature: 'simulate(service, operation, path, uid?, data?, rules?)',
    summary: 'Evaluate one request against a ruleset and report allow or deny.',
    args: z.object({
      service,
      operation: z.string().describe('The request method to evaluate.'),
      path: z.string().describe('The path the request targets.'),
      uid: z.string().optional().describe('Act as this user. Omit to use the held identity.'),
      data: z.record(z.unknown()).optional().describe('The value being written.'),
      rules: z
        .string()
        .optional()
        .describe('Rules source to evaluate. Defaults to the rules the sandbox is running.'),
    }),
    operations: [
      'simulate_firestore_rules',
      'simulate_database_rules',
      'simulate_storage_rules',
    ],
    renames: RENAMES,
    example: { service: 'firestore', operation: 'get', path: 'users/alice', uid: 'alice' },
    resolve: (args) => `simulate_${String(args.service)}_rules`,
    translate: (args) => {
      const call: Args = { operation: args.operation, path: args.path };
      for (const name of ['uid', 'data', 'rules']) {
        if (args[name] !== undefined) call[name] = args[name];
      }
      if (args.service === 'storage') delete call.data;
      return call;
    },
    check: checkOperation,
  },
  {
    name: 'explainDenial',
    sdkOrigin: 'pyric',
    signature: 'explainDenial(operation, path, service?, uid?, data?)',
    summary: 'Trace why a request was denied, rule by rule.',
    args: z.object({
      operation: z.string().describe('The request method that was denied.'),
      path: z.string().describe('Document path the request targets.'),
      service: z
        .string()
        .optional()
        .describe('The service whose rules denied the request. Only firestore has a trace.'),
      uid: z.string().optional().describe('Act as this user. Omit to use the held identity.'),
      data: z.record(z.unknown()).optional().describe('request.resource.data for a write.'),
    }),
    operations: ['diagnose_firestore_denial'],
    renames: RENAMES,
    example: { operation: 'update', path: 'users/alice', uid: 'bob' },
    resolve: () => 'diagnose_firestore_denial',
    translate: (args) => {
      const call: Args = { operation: args.operation, path: args.path };
      if (args.uid !== undefined) call.uid = args.uid;
      if (args.data !== undefined) call.data = args.data;
      return call;
    },
    check: (args, fail) => {
      const named = args.service ?? 'firestore';
      if (named !== 'firestore') {
        return fail(
          `service ${quoted(named)} has no denial trace. explainDenial reads the Firestore rules engine only in this build.`,
          `Pass service 'firestore', or call simulate for ${String(named)}.`,
          'service',
        );
      }
      return checkOperation({ ...args, service: 'firestore' }, fail);
    },
  },
  {
    name: 'set',
    sdkOrigin: 'pyric',
    signature: 'set(service, rules)',
    summary: 'Install a ruleset into the running sandbox. The rules must parse for the named service.',
    args: z.object({
      service,
      rules: z.string().describe('Rules source to install.'),
    }),
    operations: ['set_firestore_rules', 'set_database_rules', 'set_storage_rules'],
    renames: RENAMES,
    example: { service: 'firestore', rules: "rules_version = '2';\nservice cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }" },
    resolve: (args) => `set_${String(args.service)}_rules`,
    translate: (args) => ({ rules: args.rules }),
    check: checkRulesParse,
  },
  {
    name: 'listStdlib',
    sdkOrigin: 'pyric',
    signature: 'listStdlib()',
    summary: 'List every Security Rules standard library module.',
    args: z.object({}),
    operations: ['list_rules_stdlib'],
    renames: RENAMES,
    example: {},
    resolve: () => 'list_rules_stdlib',
    translate: () => ({}),
  },
  {
    name: 'getStdlib',
    sdkOrigin: 'pyric',
    signature: 'getStdlib(module)',
    summary: 'Read one standard library module signature list.',
    args: z.object({
      module: z
        .string()
        .describe('Module key from the listing, for example math or timestamp.'),
    }),
    operations: ['get_rules_stdlib'],
    renames: RENAMES,
    example: { module: 'timestamp' },
    resolve: () => 'get_rules_stdlib',
    translate: (args) => ({ module: args.module }),
  },
];

export const RULES_TOOL: ToolSpec = {
  name: 'rules',
  intro:
    'Security Rules for the sandbox, across the three services that have them. Every lint and simulate names its service, and a path is the path the request targets.',
  methods: METHODS,
};
