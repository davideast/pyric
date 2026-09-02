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
} from 'pyric/rules/internal/node';
import { createFirestoreDataTools, createFirestoreInspectTools } from 'pyric/firestore';
import { createRtdbInspectionTools } from '../../rtdb/inspection.js';
import { createSandboxSnapshotTools } from '../../sandbox/tools.js';
import { createConformanceTools } from '../../conformance/tools.js';
import type { ForwardedFactoryKey, InProcessFactoryKey } from '../tool-records.js';

/** A resolver that must never run: forwarded operations are executed by the browser peer, not here. */
export type StubResolver = () => never;

/** Factories behind forwarded operations, called with a stub so only metadata is read. */
export const FORWARDED_FACTORIES = {
  'firestore-simulator': (stub) => createFirestoreSimulatorTools({ resolveSandbox: stub as never }),
  'firestore-data': (stub) => createFirestoreDataTools({ resolveDb: stub as never }),
  'firestore-inspect': (stub) => createFirestoreInspectTools({ resolveSandbox: stub as never }),
  'rtdb-inspection': (stub) => createRtdbInspectionTools({ resolveSandbox: stub as never }),
  'sandbox-snapshot': (stub) => createSandboxSnapshotTools({ resolveSandbox: stub as never }),
} satisfies Record<ForwardedFactoryKey, (stub: StubResolver) => ToolHandler[]>;

/**
 * Factories behind in-process operations, returned as live handlers the MCP
 * server executes directly. The default surface carries no project scope, so
 * the rules factory yields only its local handlers.
 */
export const IN_PROCESS_FACTORIES = {
  'firestore-rules': () => createFirestoreRulesTools(),
  conformance: () => createConformanceTools(),
} satisfies Record<InProcessFactoryKey, () => ToolHandler[]>;
