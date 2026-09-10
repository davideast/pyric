/**
 * Node-side factory for each tool family. This is the only bridge module
 * that imports `pyric/rules/internal/node` or the conformance tools; the
 * browser side has its own map in `client/tool-family-factories.ts`.
 *
 * The keys are the family record filenames. `satisfies` against the keys
 * derived from the generated aggregate makes a missing or surplus entry a
 * compile error.
 */
import type { ToolHandler } from '@inbrowser/agent';
import {
  createFirestoreSimulatorTools,
  createFirestoreRulesTools,
} from 'pyric/rules/internal/node';
import { createFirestoreDataTools, createFirestoreInspectTools } from 'pyric/firestore';
import { createRtdbInspectionTools } from '../../rtdb/inspection.js';
import { createAuthUsersTools } from '../../auth/users.js';
import { createAuthIdentityTools } from '../../auth/identity-tools.js';
import { createConformanceTools } from '../../conformance/tools.js';
import type { CallerIdentityStore, SessionRegistry } from '../../auth/identity.js';
import type { ForwardedFamilyKey, InProcessFamilyKey } from '../tool-families.js';

/**
 * What an in-process family may be given at composition time. `scope` reaches
 * the rules factory's hosted verification tool; `consumers` is the running
 * bridge's registry of connected clients and `callerIdentity` is the identity
 * that bridge attributes to its own MCP callers, both of which the auth
 * identity family reads and writes. All are absent on an in-process surface, and
 * each family degrades on its own.
 */
export interface InProcessToolContext {
  scope?: unknown;
  consumers?: SessionRegistry;
  callerIdentity?: CallerIdentityStore;
}

/** A resolver that must never run: forwarded families are executed by the browser peer, not here. */
export type StubResolver = () => never;

/** Forwarded families, called with a stub so only metadata is read. */
export const FORWARDED_METADATA_FACTORIES = {
  'firestore-simulator': (stub) => createFirestoreSimulatorTools({ resolveSandbox: stub as never }),
  'firestore-data': (stub) => createFirestoreDataTools({ resolveDb: stub as never }),
  'firestore-inspect': (stub) => createFirestoreInspectTools({ resolveSandbox: stub as never }),
  'rtdb-inspection': (stub) => createRtdbInspectionTools({ resolveSandbox: stub as never }),
  'auth-users': (stub) => createAuthUsersTools({ resolveSandbox: stub as never }),
} satisfies Record<ForwardedFamilyKey, (stub: StubResolver) => ToolHandler[]>;

/**
 * In-process families, returned as live handlers the MCP server registers
 * directly. The context reaches the families that need process state: the
 * rules factory appends a hosted verification tool only when a `scope` is
 * supplied, and the auth identity family reads the bridge's connected clients
 * and caller identity. The default surface supplies none of them, and each
 * family says so at call time rather than failing to compose.
 */
export const IN_PROCESS_HANDLER_FACTORIES = {
  'firestore-rules': (context) => createFirestoreRulesTools({ scope: context?.scope } as never),
  'auth-identity': (context) =>
    createAuthIdentityTools({ sessions: context?.consumers, caller: context?.callerIdentity }),
  conformance: () => createConformanceTools(),
} satisfies Record<InProcessFamilyKey, (context?: InProcessToolContext) => ToolHandler[]>;
