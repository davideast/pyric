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
import { createConformanceTools } from '../../conformance/tools.js';
import type { ForwardedFamilyKey, InProcessFamilyKey } from '../tool-families.js';

/** A resolver that must never run: forwarded families are executed by the browser peer, not here. */
export type StubResolver = () => never;

/** Forwarded families, called with a stub so only metadata is read. */
export const FORWARDED_METADATA_FACTORIES = {
  'firestore-simulator': (stub) => createFirestoreSimulatorTools({ resolveSandbox: stub as never }),
  'firestore-data': (stub) => createFirestoreDataTools({ resolveDb: stub as never }),
  'firestore-inspect': (stub) => createFirestoreInspectTools({ resolveSandbox: stub as never }),
  'rtdb-inspection': (stub) => createRtdbInspectionTools({ resolveSandbox: stub as never }),
} satisfies Record<ForwardedFamilyKey, (stub: StubResolver) => ToolHandler[]>;

/**
 * In-process families, returned as live handlers the MCP server registers
 * directly. `scope` reaches the rules factory, which appends a hosted
 * verification tool only when one is supplied; the default surface supplies
 * none.
 */
export const IN_PROCESS_HANDLER_FACTORIES = {
  'firestore-rules': (scope) => createFirestoreRulesTools({ scope } as never),
  conformance: () => createConformanceTools(),
} satisfies Record<InProcessFamilyKey, (scope?: unknown) => ToolHandler[]>;
