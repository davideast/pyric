/**
 * Install a served project's Storage rules into a sandbox, per bucket, the
 * same way on every served plane: the SharedWorker, the in-page runtime and
 * the Node host.
 *
 * The default bucket's rules open the Storage service, which honors rules
 * only on its first open. Each bucket `firebase.json` names gets its own
 * rules by name, and a bucket nothing deploys to is locked, as production
 * creates a bucket (#1313). A dev server's later rules change arrives as a
 * {@link StorageRulesUpdate} and replaces one bucket's rules in place.
 */
import type { Sandbox } from 'pyric/sandbox';
import { getStorageSandbox } from 'pyric/storage';
import {
  deployStorageBucketRules,
  lockUndeployedStorageBuckets,
  replaceStorageRules,
} from 'pyric/storage/internal';
import type { InitPayload } from './init-payload.js';

/** One bucket's rules change, as a dev server broadcasts it. */
export interface StorageRulesUpdate {
  /** The new source, or null when the file was deleted and the bucket returns to denying. */
  rules: string | null;
  rulesHash?: string | null;
  /** The bucket by name, absent for the default bucket. */
  bucket?: string;
}

/** Open the sandbox's Storage service with the payload's rules for every bucket. */
export function installServedStorageRules(
  sandbox: Sandbox,
  payload: Pick<InitPayload, 'storageRules' | 'storageBucketRules' | 'projectKey'>,
): void {
  getStorageSandbox(sandbox, {
    ...(payload.storageRules ? { rules: payload.storageRules } : {}),
    ...(payload.projectKey ? { projectId: payload.projectKey } : {}),
  });
  lockUndeployedStorageBuckets(sandbox);
  for (const [bucket, deployed] of Object.entries(payload.storageBucketRules ?? {})) {
    deployStorageBucketRules(sandbox, bucket, deployed.rules);
  }
}

/** Apply one bucket's rules change. */
export async function applyStorageRulesUpdate(sandbox: Sandbox, update: StorageRulesUpdate): Promise<void> {
  await replaceStorageRules(sandbox, update.rules, update.bucket === undefined ? {} : { bucket: update.bucket });
}

/** What a served plane logs for one bucket's rules change. */
export function storageRulesUpdateNotice(update: StorageRulesUpdate): string {
  const file = update.bucket === undefined ? 'storage.rules' : `storage rules for bucket ${update.bucket}`;
  if (update.rules === null) return `${file} removed; client Storage operations on it default to deny`;
  return `${file} hot-reloaded`;
}
