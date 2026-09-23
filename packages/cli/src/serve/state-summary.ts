import { z } from 'zod';
import { STATE_FILE_VERSION, type PyricStateFile } from './state-file.js';
import type { StateStore } from './state-store.js';

const servicesSchema = z.object({
  auth: z.object({ users: z.array(z.unknown()) }).optional(),
});
const controllerSchema = z.object({
  firestore: z.record(z.unknown()).optional(),
  services: servicesSchema.optional(),
  records: z.record(z.object({
    docs: z.record(z.unknown()).optional(),
    services: servicesSchema.optional(),
  })).optional(),
});

/** Read counts without decoding document values or serialising the full keyspace again. */
function controllerSummary(section: unknown): { documents: number; users?: number } {
  const parsed = controllerSchema.safeParse(section);
  const hasNoController = !parsed.success;
  if (hasNoController) return { documents: 0 };
  const controller = parsed.data;
  const records = controller.records;
  const usesBuckets = records !== undefined;
  if (usesBuckets) {
    const paths = new Set<string>();
    for (const record of Object.values(records)) {
      const documents = record.docs ?? {};
      for (const path of Object.keys(documents)) paths.add(path);
    }
    return { documents: paths.size, users: records.meta?.services?.auth?.users.length };
  }
  const documents = controller.firestore ?? {};
  return { documents: Object.keys(documents).length, users: controller.services?.auth?.users.length };
}

/** Document count for both legacy controller snapshots and bucketed records. */
export function firestoreDocCount(section: unknown): number {
  return controllerSummary(section).documents;
}

/** Controller accounts take precedence over the older separate Auth section, including an empty list. */
export function restoredStateCounts(state: PyricStateFile | null) {
  const controller = controllerSummary(state?.firestore);
  const users = controller.users;
  const hasControllerUsers = users !== undefined;
  if (hasControllerUsers) return { restoredDocs: controller.documents, restoredUsers: users };
  return { restoredDocs: controller.documents, restoredUsers: state?.auth?.users.length ?? 0 };
}

/**
 * The state the startup summary counts. A hosted store is read by section, so
 * its Storage objects, which the summary does not report, are never loaded.
 */
export function stateForSummary(
  state: StateStore | undefined,
  options: { hosted: boolean },
): PyricStateFile | null {
  const hasNoState = state === undefined || !state.exists();
  if (hasNoState) return null;
  const readsWholeFile = !options.hosted;
  if (readsWholeFile) return state.load();
  return {
    version: STATE_FILE_VERSION,
    firestore: state.readSection('firestore'),
    auth: state.readSection('auth') as PyricStateFile['auth'],
  };
}
