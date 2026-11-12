/**
 * Clear one service, or every service, in the sandbox.
 *
 * `reset` is destructive, so the shared effect enforcement in
 * `method-validation.ts` refuses the call unless `args.confirm === true`
 * before this record's own `handler` ever runs. The default scope, `all`,
 * clears every service at once, is one word away from `inspect` in an
 * agent's vocabulary, and the state it clears is the state a task was seeded
 * with, so the cost of an accidental call is the whole run. A named scope
 * clears only that service's data; the others are untouched.
 */
import { z } from 'zod';
import { deleteDoc, doc, getAdminFirestore } from 'pyric/firestore';
import { setRules as setFirestoreRules, snapshotDocuments } from 'pyric/sandbox/firestore';
import { getInternalEnv, withDatabaseRulesPreservedOnReset } from 'pyric/sandbox/internal';
import {
  getAdminDatabase,
  ref as databaseRef,
  remove as databaseRemove,
} from 'pyric/database';
import {
  getActiveRules as getActiveDatabaseRules,
  setRules as setDatabaseRules,
} from 'pyric/sandbox/database';
import { heldDatabaseInstances } from 'pyric/database/internal';
import { deleteObject, ref as storageRef } from 'pyric/storage';
import {
  DEFAULT_BUCKET,
  deployStorageBucketRules,
  getAdminStorageSandbox,
  getStorageRulesResolution,
  nameStorageBucket,
  replaceStorageRules,
  storageBucketsWithRules,
} from 'pyric/storage/internal';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { listStoredPaths } from '../../storage-state.js';
import type { MethodRecord } from '../../method-types.js';
import type { SandboxSurfaceContext } from '../../types.js';

const STORAGE_SERVICE_CACHES_KEY = Symbol.for('pyric.storage.service-caches');

function heldNamedStorageBuckets(sandbox: SandboxSurfaceContext['sandbox']): string[] {
  const holder = globalThis as {
    [STORAGE_SERVICE_CACHES_KEY]?: {
      scopedServices?: WeakMap<object, Map<string, unknown>>;
    };
  };
  const scoped = holder[STORAGE_SERVICE_CACHES_KEY]?.scopedServices?.get(sandbox);
  return scoped ? [...scoped.keys()] : [];
}

/** The services a reset can be narrowed to, and `all` for every one of them. */
export const RESET_SCOPES = ['all', 'firestore', 'database', 'storage', 'auth'] as const;
type Scope = (typeof RESET_SCOPES)[number];

async function resetScope(scope: Scope, ctx: SandboxSurfaceContext): Promise<void> {
  if (scope === 'firestore') {
    const db = getAdminFirestore(ctx.sandbox);
    for (const path of Object.keys(snapshotDocuments(ctx.sandbox))) {
      await deleteDoc(doc(db, path));
    }
    return;
  }
  if (scope === 'database') {
    await databaseRemove(databaseRef(getAdminDatabase(ctx.sandbox)));
    const catalog = await ctx.databaseInstances();
    const named = new Set([...catalog.known().named, ...heldDatabaseInstances(ctx.sandbox)]);
    for (const instance of named) {
      await databaseRemove(databaseRef(getAdminDatabase(ctx.sandbox, instance)));
    }
    return;
  }
  if (scope === 'storage') {
    const storage = getAdminStorageSandbox(ctx.sandbox);
    for (const path of await listStoredPaths(storage)) {
      await deleteObject(storageRef(storage, path));
    }
    const namedBuckets = new Set([
      ...storageBucketsWithRules(ctx.sandbox),
      ...heldNamedStorageBuckets(ctx.sandbox),
    ]);
    for (const bucket of namedBuckets) {
      if (!bucket || bucket === DEFAULT_BUCKET) continue;
      const namedStorage = getAdminStorageSandbox(ctx.sandbox, { bucket });
      for (const path of await listStoredPaths(namedStorage)) {
        await deleteObject(storageRef(namedStorage, path));
      }
    }
    return;
  }
  authSandbox.clearUsers(getAuth(ctx.sandbox));
}

export default {
  tool: 'sandbox',
  method: 'reset',
  runsIn: 'sandbox',
  sdkOrigin: 'pyric',
  effect: 'destructive',
  signature: `reset(scope?: ${RESET_SCOPES.join('|')}, confirm)`,
  description: 'Discard everything, or one service.',
  args: z.object({
    scope: z.enum(RESET_SCOPES).optional(),
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true. Reset clears documents, values, objects, and users.'),
  }),
  operation: 'reset_sandbox',
  renames: { confirmed: 'confirm', force: 'confirm', yes: 'confirm' },
  example: { confirm: true },
  async handler(args, ctx) {
    const scope = (typeof args.scope === 'string' ? args.scope : 'all') as Scope;
    if (scope === 'all') {
      const firestoreRules = getInternalEnv(ctx.sandbox).getRules();
      const heldNamedDbs = [...heldDatabaseInstances(ctx.sandbox)];
      const namedDbRules = new Map(
        heldNamedDbs.map((instance) => [
          instance,
          getActiveDatabaseRules(getAdminDatabase(ctx.sandbox, instance)),
        ]),
      );
      const defaultStorageRules =
        getStorageRulesResolution(getAdminStorageSandbox(ctx.sandbox))?.source ?? null;
      const bucketStorageRules = new Map<string, string>();
      for (const bucket of storageBucketsWithRules(ctx.sandbox)) {
        const handle = nameStorageBucket(getAdminStorageSandbox(ctx.sandbox, { bucket }), bucket);
        const source = getStorageRulesResolution(handle)?.source;
        if (source !== undefined) bucketStorageRules.set(bucket, source);
      }

      const outcome = await withDatabaseRulesPreservedOnReset(ctx.sandbox, () => ctx.sandbox.resetAll());
      for (const instance of heldNamedDbs) {
        await databaseRemove(databaseRef(getAdminDatabase(ctx.sandbox, instance)));
      }
      if (firestoreRules !== '') setFirestoreRules(ctx.sandbox, firestoreRules);
      for (const [instance, rules] of namedDbRules) {
        if (rules !== null) {
          setDatabaseRules(getAdminDatabase(ctx.sandbox, instance), structuredClone(rules));
        }
      }
      if (defaultStorageRules !== null) {
        await replaceStorageRules(ctx.sandbox, defaultStorageRules, {});
      }
      for (const [bucket, source] of bucketStorageRules) {
        deployStorageBucketRules(ctx.sandbox, bucket, source);
      }

      if (outcome.errors.length > 0) {
        return {
          ok: false,
          summary: `Reset finished with ${outcome.errors.length} service errors.`,
          data: { errors: outcome.errors },
        };
      }
      return { ok: true, summary: 'Sandbox reset.', data: { errors: [] } };
    }
    await resetScope(scope, ctx);
    return { ok: true, summary: `Reset the ${scope} service.`, data: { scope } };
  },
} satisfies MethodRecord;
