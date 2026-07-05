/**
 * The `storage` deploy provider — the fourth-app gap, finally a first-class
 * target. It adds NO new deploy logic: it wraps the existing `pyric/storage`
 * admin tool (`storage_provision`, which enables the API, creates the
 * bucket, and deploys rules to the PER-BUCKET release `firebase.storage/{bucket}`),
 * and just maps firebase.json's `storage` block to that tool's args — one unit
 * per bucket (the plural contract the hosting wrap proved out).
 */
import { resolve as resolvePath } from 'node:path';
import { createStorageAdminTools } from 'pyric/storage';
import type { DeployProvider, ConfigSource, ResolveResult } from '../provider.js';
import { SCOPES } from '../../credentials/core/scopes.js';

/** The args `storage_provision` expects (one per bucket). */
interface StorageArgs {
  bucketId?: string;
  rules?: string;
}

export const storageProvider: DeployProvider<StorageArgs> = {
  target: 'storage',
  summary: 'Provision the default bucket + deploy Storage rules (per-bucket release)',
  operations: [{ name: 'provision', default: true, toolName: 'storage_provision' }],
  requiredScope: SCOPES.cloudPlatform,
  requiredApis: [
    'firebase.googleapis.com',
    'firebasestorage.googleapis.com',
    'storage.googleapis.com',
    'firebaserules.googleapis.com',
  ],
  tools: (scope) => createStorageAdminTools({ scope }),
  async resolveConfig(_op, src): Promise<ResolveResult<StorageArgs>> {
    const block = src.firebaseJson.storage;
    if (!block) {
      return { ok: false, message: 'firebase.json has no `storage` block (need `{ rules: "storage.rules" }`).' };
    }
    const entries = (Array.isArray(block) ? block : [block]).filter((e) => !!e && typeof e === 'object');
    if (entries.length === 0) {
      return { ok: false, message: '`storage` block is empty.' };
    }
    const units: StorageArgs[] = [];
    for (const entry of entries) {
      const args: StorageArgs = {};
      if (entry.bucket) args.bucketId = entry.bucket;
      // `rules` is a path in firebase.json; the tool wants the source text.
      if (entry.rules) args.rules = await src.readFile(resolvePath(src.cwd, entry.rules));
      units.push(args);
    }
    return { ok: true, units };
  },
};
