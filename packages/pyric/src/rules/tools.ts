/**
 * Tool factories for `pyric/rules` per F1.
 *
 *   - `createFirestoreRulesTools()`: pure-local rules tooling
 *     (lint, parse, resolve-modules, simulate) + the Rules Test API
 *     client (test, takes ProjectScope).
 *   - `createFirestoreSimulatorTools({ resolveSandbox })`: stateful
 *     simulator tools — create, execute, read, batch, transaction,
 *     undo, events. Tools operate against a session-scoped
 *     LocalEnvironment resolved per dispatch.
 *
 * Per F2: identity is a value; lifecycle is a resolver. The
 * `resolveSandbox` resolver returns the session's
 * LocalEnvironment — handlers call it inside `execute` so reset /
 * swap is transparent.
 *
 * Per F5: handlers are self-contained — only deps + args + ctx;
 * no globals.
 */

import type { ToolHandler } from '@inbrowser/agent';
import type { ProjectScope } from '../project-scope.js';
import { parseToAST } from './grammar/FirestoreParser.js';
import { validateFirestoreRules } from './grammar/FirestoreValidator.js';
import { resolveModules } from './modules/resolver.js';
import { SimulateFirestoreRulesHandler } from './simulator/handler.js';
import { createFirestoreRulesStdlibTools } from './stdlib-tools.js';
import { TestFirestoreRulesHandler } from './test/handler.js';
import type { TestCase } from './test/spec.js';
import {
  createFirestoreSimulatorTools as createFirestoreSimulatorToolsImpl,
  type FirestoreSimulatorToolDeps as FirestoreSimulatorToolDepsImpl,
} from './simulator-tools-impl.js';

// Re-exported for back-compat with consumers that imported the type
// from `pyric/rules/internal/node` (where this file is exposed).
export type FirestoreSimulatorToolDeps = Pick<
  FirestoreSimulatorToolDepsImpl,
  'resolveSandbox'
>;

// ─── createFirestoreRulesTools ────────────────────────────────────────

export interface FirestoreRulesToolDeps {
  /** Optional ProjectScope for the test-rules tool (calls Google's
   *  Firebase Rules Test API). When omitted, `firestore_test_rules`
   *  is dropped from the factory's output. */
  scope?: ProjectScope;
}

/**
 * Pure-local Firestore rules tooling, plus the optional Rules Test
 * API client when `scope` is supplied. Bundles:
 *
 *   - `firestore_lint_rules`
 *   - `firestore_resolve_modules`
 *   - `firestore_simulate_rules`
 *   - `firestore_validate_rules`
 *   - `firestore_test_rules` (only when `scope` is supplied)
 */
export function createFirestoreRulesTools(
  deps: FirestoreRulesToolDeps = {},
): ToolHandler[] {
  const handlers: ToolHandler[] = [
    // Firestore lint/resolve plus the service-neutral catalog and resolver are
    // provided by `createFirestoreRulesStdlibTools()` (browser-safe;
    // stdlib content inlined at build time) and spread in below.
    // Node consumers that need `basePath`-driven relative-import
    // resolution should call the `resolveModules` function directly
    // — the public tool surface intentionally keeps the schema
    // browser-friendly.
    {
      name: 'firestore_simulate_rules',
      description:
        'Simulate Firestore security rules locally against a list of test cases. Same shape as `firestore_test_rules` but in-process — no propagation wait, no side effects. Supports get()/exists() via functionMocks.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          testCases: { type: 'array' },
        },
        required: ['source', 'testCases'],
      },
      async execute(args) {
        const { source, testCases } = args as {
          source: string;
          testCases: TestCase[];
        };
        const handler = new SimulateFirestoreRulesHandler();
        const result = handler.simulate(source, testCases);
        return {
          ok: result.success,
          summary: result.success
            ? `${result.data.results.filter((r) => r.state === 'PASSED').length}/${result.data.results.length} test cases passed`
            : `Simulation failed: ${result.error.message}`,
          data: result,
        };
      },
    },
    {
      name: 'firestore_validate_rules',
      description:
        'Validate a Firestore Security Rules source: parse it and run the structural validator, which reports security findings (open reads or writes, missing auth checks) and semantic findings (undefined functions, wrong arity) with a severity of critical, high, medium, or low. Pure-local — no auth, no network. Complements `firestore_lint_rules`, which checks syntax, budgets, and smells.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Firestore security rules source text to validate.',
          },
        },
        required: ['source'],
      },
      async execute(args) {
        const { source } = args as { source: string };
        const ast = parseToAST(source);
        if (!ast) {
          return {
            ok: false,
            summary: 'Parse failed — the source does not parse as Firestore rules',
            data: { findings: [], parseError: true },
          };
        }
        const findings = validateFirestoreRules(ast);
        const blocking = findings.filter(
          (finding) => finding.severity === 'critical' || finding.severity === 'high',
        ).length;
        return {
          ok: blocking === 0,
          summary:
            findings.length === 0
              ? 'Validation clean'
              : `Validation found ${findings.length} finding${findings.length === 1 ? '' : 's'} (${blocking} critical or high)`,
          data: { findings },
        };
      },
    },
    // Stdlib reference and resolver tools — pure data/source transforms,
    // browser-safe.
    // Defined in `./stdlib-tools.ts` so consumers that only need the
    // reference (the playground, browser docs generators) don't pull
    // in the Node-only resolver via this Node-only factory.
    ...createFirestoreRulesStdlibTools(),
  ];

  if (deps.scope) {
    const scope = deps.scope;
    // Deployed-rules inspection is a separate opt-in surface. Browser and
    // Node callers that need parsed rules wire `createFirestoreInspectTool`
    // directly from `pyric/rules`.
    handlers.push({
      name: 'firestore_test_rules',
      description:
        'Test Firestore security rules against test cases via the Firebase Rules Test API. Requires a ProjectScope (auth credentials).',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          testCases: { type: 'array' },
          expressionReportLevel: { type: 'string', enum: ['NONE', 'VISITED', 'FULL'] },
        },
        required: ['source', 'testCases'],
      },
      async execute(args) {
        const { source, testCases, expressionReportLevel } = args as {
          source: string;
          testCases: TestCase[];
          expressionReportLevel?: 'NONE' | 'VISITED' | 'FULL';
        };
        const handler = new TestFirestoreRulesHandler();
        const result = await handler.execute(scope, source, testCases, { expressionReportLevel });
        return {
          ok: result.success,
          summary: result.success
            ? `${result.data.passed}/${result.data.passed + result.data.failed} test cases passed`
            : `Rules test failed: ${result.error.message}`,
          data: result,
        };
      },
    });
  }

  return handlers;
}

// ─── createFirestoreSimulatorTools ────────────────────────────────────
//
// Implementation lives in ./simulator-tools-impl.ts so the same factory
// can run in both Node and browser bundles without forcing the Node-only
// `resolveModules` (disk reads) into the browser. The /node entry below
// wires `resolveModules` from `./modules/resolver.js`; the browser-safe
// `/simulator` entry wires `resolveModulesBrowser`. See `./simulator.ts`.
//
export function createFirestoreSimulatorTools(
  deps: FirestoreSimulatorToolDeps,
): ToolHandler[] {
  return createFirestoreSimulatorToolsImpl({
    resolveSandbox: deps.resolveSandbox,
    resolveModulesFn: resolveModules,
  });
}
