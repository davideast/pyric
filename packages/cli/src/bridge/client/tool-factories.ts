/**
 * Browser-side factory for each handler factory behind a forwarded
 * operation, bound to one sandbox. Imports only browser-safe subpaths
 * (`pyric/rules/internal`, never `/node`); the Node side has its own map in
 * `server/tool-factories.ts`.
 *
 * The keys are the `factory` values the records use. `satisfies` against the
 * keys derived from the generated aggregate makes a missing or surplus entry
 * a compile error.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { createFirestoreSimulatorTools } from 'pyric/rules/internal';
import {
  createFirestoreDataTools,
  createFirestoreInspectTools,
  type FirestoreDataToolDeps,
} from 'pyric/firestore';
import { createStorageDataTools, type StorageDataToolDeps } from 'pyric/storage';
import type { LocalSandbox } from 'pyric/sandbox';
import type { getInternalEnv } from 'pyric/sandbox/internal';
import { createRtdbInspectionTools } from '../../rtdb/inspection.js';
import { createSandboxSnapshotTools } from '../../sandbox/tools.js';
import type { ForwardedFactoryKey } from '../tool-records.js';

/** Everything a forwarded factory needs from one sandbox, built once per sandbox. */
export interface SandboxBinding {
  sandbox: LocalSandbox;
  env: ReturnType<typeof getInternalEnv>;
  resolveDb: FirestoreDataToolDeps['resolveDb'];
  resolveStorage: StorageDataToolDeps['resolveStorage'];
}

export const SANDBOX_FACTORIES = {
  'firestore-simulator': ({ env }) => createFirestoreSimulatorTools({ resolveSandbox: () => env }),
  'firestore-data': ({ resolveDb }) => createFirestoreDataTools({ resolveDb }),
  'firestore-inspect': ({ sandbox }) => createFirestoreInspectTools({ resolveSandbox: () => sandbox }),
  'rtdb-inspection': ({ sandbox }) => createRtdbInspectionTools({ resolveSandbox: () => sandbox }),
  'storage-data': ({ resolveStorage }) => createStorageDataTools({ resolveStorage }),
  'sandbox-snapshot': ({ sandbox }) => createSandboxSnapshotTools({ resolveSandbox: () => sandbox }),
} satisfies Record<ForwardedFactoryKey, (binding: SandboxBinding) => ToolHandler[]>;
