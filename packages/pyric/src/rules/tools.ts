/**
 * Tool factories for `pyric/rules` per F1.
 *
 *   - `createFirestoreRulesTools({ scope? })`: pure-local rules tooling
 *     (lint, parse, resolve-modules, simulate) + the Rules Test API
 *     client (test). The test handler is always yielded; without a
 *     ProjectScope it returns an explicit error instead of calling out.
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
   *  is still yielded and every call returns the credentials error. */
  scope?: ProjectScope;
}

/** The result `firestore_test_rules` returns when no ProjectScope was supplied. */
export const FIRESTORE_TEST_RULES_SCOPE_REQUIRED =
  'firestore_test_rules: the Rules Test API requires a ProjectScope. Configure project credentials and restart the bridge.';

/**
 * Pure-local Firestore rules tooling plus the Rules Test API client.
 * Bundles:
 *
 *   - `firestore_lint_rules`
 *   - `firestore_resolve_modules`
 *   - `firestore_simulate_rules`
 *   - `firestore_test_rules` (returns the credentials error without `scope`)
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
    // Stdlib reference and resolver tools — pure data/source transforms,
    // browser-safe.
    // Defined in `./stdlib-tools.ts` so consumers that only need the
    // reference (the playground, browser docs generators) don't pull
    // in the Node-only resolver via this Node-only factory.
    ...createFirestoreRulesStdlibTools(),
  ];

  const scope = deps.scope;
  // Deployed-rules inspection is a separate opt-in surface. Browser and
  // Node callers that need parsed rules wire `createFirestoreInspectTool`
  // directly from `pyric/rules`.
  handlers.push({
    name: 'firestore_test_rules',
    description:
      'Test Firestore security rules against test cases via the Firebase Rules Test API. Requires project credentials (a ProjectScope) on the server; without them every call returns an error.',
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
      if (!scope) {
        return { ok: false, summary: FIRESTORE_TEST_RULES_SCOPE_REQUIRED };
      }
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
