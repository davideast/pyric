/**
 * Browser-side factory for each forwarded tool family, bound to one
 * sandbox. Imports only browser-safe subpaths (`pyric/rules/internal`, never
 * `/node`); the Node side has its own map in `server/tool-family-factories.ts`.
 *
 * The keys are the family record filenames. `satisfies` against the keys
 * derived from the generated aggregate makes a missing or surplus entry a
 * compile error.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { createFirestoreSimulatorTools } from 'pyric/rules/internal';
import {
  createFirestoreDataTools,
  createFirestoreInspectTools,
  type FirestoreDataToolDeps,
} from 'pyric/firestore';
import type { LocalSandbox } from 'pyric/sandbox';
import type { getInternalEnv } from 'pyric/sandbox/internal';
import { createRtdbInspectionTools } from '../../rtdb/inspection.js';
import type { ForwardedFamilyKey } from '../tool-families.js';

/** Everything a forwarded family needs from one sandbox, built once per sandbox. */
export interface SandboxBinding {
  sandbox: LocalSandbox;
  env: ReturnType<typeof getInternalEnv>;
  resolveDb: FirestoreDataToolDeps['resolveDb'];
}

export const SANDBOX_HANDLER_FACTORIES = {
  'firestore-simulator': ({ env }) => createFirestoreSimulatorTools({ resolveSandbox: () => env }),
  'firestore-data': ({ resolveDb }) => createFirestoreDataTools({ resolveDb }),
  'firestore-inspect': ({ sandbox }) => createFirestoreInspectTools({ resolveSandbox: () => sandbox }),
  'rtdb-inspection': ({ sandbox }) => createRtdbInspectionTools({ resolveSandbox: () => sandbox }),
} satisfies Record<ForwardedFamilyKey, (binding: SandboxBinding) => ToolHandler[]>;
