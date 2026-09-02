/**
 * Node-side factory for each handler factory the tool records name. This is
 * the only bridge module that imports `pyric/rules/internal/node` or the
 * conformance tools; the browser side has its own map in
 * `client/tool-factories.ts`.
 *
 * The keys are the `factory` values the records use. `satisfies` against the
 * keys derived from the generated aggregate makes a missing or surplus entry
 * a compile error.
 */
import type { ToolHandler } from '@inbrowser/agent';
import {
  createFirestoreSimulatorTools,
  createFirestoreRulesTools,
  createFirestoreIndexesTools,
} from 'pyric/rules/internal/node';
import { createFirestoreDataTools, createFirestoreInspectTools } from 'pyric/firestore';
import { createStorageDataTools } from 'pyric/storage';
import { createDatabaseDataTools } from 'pyric/database';
import { createAuthUserTools } from 'pyric/auth';
import { createRtdbInspectionTools } from '../../rtdb/inspection.js';
import { createSandboxSnapshotTools } from '../../sandbox/tools.js';
import { createConformanceTools } from '../../conformance/tools.js';
import { createVerifyTools } from '../../verify/tools.js';
import type { ProjectScope } from '../../credentials/core/types.js';
import type { ForwardedFactoryKey, InProcessFactoryKey } from '../tool-records.js';

/** A resolver that must never run: forwarded operations are executed by the browser peer, not here. */
export type StubResolver = () => never;

/** Factories behind forwarded operations, called with a stub so only metadata is read. */
export const FORWARDED_FACTORIES = {
  'firestore-simulator': (stub) => createFirestoreSimulatorTools({ resolveSandbox: stub as never }),
  'firestore-data': (stub) => createFirestoreDataTools({ resolveDb: stub as never }),
  'firestore-inspect': (stub) => createFirestoreInspectTools({ resolveSandbox: stub as never }),
  'rtdb-inspection': (stub) => createRtdbInspectionTools({ resolveSandbox: stub as never }),
  'storage-data': (stub) => createStorageDataTools({ resolveStorage: stub as never }),
  'sandbox-snapshot': (stub) => createSandboxSnapshotTools({ resolveSandbox: stub as never }),
  'database-data': (stub) => createDatabaseDataTools({ resolveDatabase: stub as never }),
  'auth-users': (stub) => createAuthUserTools({ resolveSandbox: stub as never }),
} satisfies Record<ForwardedFactoryKey, (stub: StubResolver) => ToolHandler[]>;

/**
 * What an in-process factory receives from the entry point that composes
 * the bridge. `scope` is the project credentials resolved once at startup
 * (`server/scope.ts`); it is absent when none resolved, and the handlers
 * that need it then return their explicit credentials error on use.
 */
export interface InProcessContext {
  scope?: ProjectScope;
}

/**
 * Factories behind in-process operations, returned as live handlers the MCP
 * server executes directly. Every factory yields the same handler names with
 * or without a scope, so the manifest never depends on credentials.
 */
export const IN_PROCESS_FACTORIES = {
  'firestore-rules': ({ scope }: InProcessContext = {}) =>
    createFirestoreRulesTools(scope ? { scope } : {}),
  'firestore-indexes': () => createFirestoreIndexesTools(),
  conformance: () => createConformanceTools(),
  verify: ({ scope }: InProcessContext = {}) => createVerifyTools(scope ? { scope } : {}),
} satisfies Record<InProcessFactoryKey, (context?: InProcessContext) => ToolHandler[]>;
