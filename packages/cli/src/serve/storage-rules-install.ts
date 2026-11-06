/**
 * Install a served project's Storage rules into a sandbox, per bucket, the
 * same way on every served plane: the SharedWorker, the in-page runtime and
 * the Node host.
 *
 * The default bucket's rules open the Storage service, which honors rules
 * only on its first open. Each bucket `firebase.json` names gets its own
 * rules by name, and a bucket nothing deploys to is locked, as production
 * creates a bucket (#1313), or open when the session is permissive (owner
 * decision multi-resource-1), as an RTDB instance without rules is. A deploy target no project resolved when the
 * server started deploys to its buckets once the page's app config names
 * the project. A dev server's later rules change arrives as a
 * {@link StorageRulesUpdate} and replaces one bucket's or one target's rules
 * in place.
 */
import type { Sandbox } from 'pyric/sandbox';
import { getStorageSandbox } from 'pyric/storage';
import {
  deployStorageBucketRules,
  lockUndeployedStorageBuckets,
  replaceStorageRules,
} from 'pyric/storage/internal';
import type { InitPayload, PendingStorageTargetRules, RulesDestination } from './init-payload.js';

/** One bucket's or one deploy target's rules change, as a dev server broadcasts it. */
export interface StorageRulesUpdate {
  /** The new source, or null when the file was deleted and the bucket returns to denying. */
  rules: string | null;
  rulesHash?: string | null;
  /** The bucket by name, absent for the default bucket. */
  bucket?: string;
  /** A deploy target no project resolved at startup, in place of `bucket`. */
  target?: string;
}

/** A pending deploy target's rules, and the buckets it deploys to once resolved. */
interface PendingTarget {
  entry: PendingStorageTargetRules;
  buckets: string[] | null;
}

/** Each sandbox's deploy targets no project resolved at startup, by target name. */
const pendingTargetsBySandbox = new WeakMap<Sandbox, Map<string, PendingTarget>>();

/** The first project an app config named on each sandbox, kept for targets installed after it. */
const appProjectBySandbox = new WeakMap<Sandbox, string>();

/**
 * Open the sandbox's Storage service with the payload's rules for every
 * bucket. Returns the notices of pending targets an app config that named
 * its project first resolved.
 */
export function installServedStorageRules(
  sandbox: Sandbox,
  payload: Pick<InitPayload, 'storageRules' | 'storageBucketRules' | 'storagePendingTargets' | 'projectKey' | 'permissive'>,
): string[] {
  getStorageSandbox(sandbox, {
    ...(payload.storageRules ? { rules: payload.storageRules } : {}),
    ...(payload.projectKey ? { projectId: payload.projectKey } : {}),
  });
  lockUndeployedStorageBuckets(sandbox, payload.permissive === true ? 'allow' : 'deny');
  for (const [bucket, deployed] of Object.entries(payload.storageBucketRules ?? {})) {
    deployStorageBucketRules(sandbox, bucket, deployed.rules);
  }
  const pending = payload.storagePendingTargets ?? [];
  if (pending.length === 0) return [];
  pendingTargetsBySandbox.set(sandbox, new Map(pending.map((entry) => [entry.target, { entry: { ...entry }, buckets: null }])));
  return resolvePendingStorageTargets(sandbox, appProjectBySandbox.get(sandbox));
}

/** Whether the sandbox holds deploy targets that wait for an app config's project. */
export function hasPendingStorageTargets(sandbox: Sandbox): boolean {
  const pending = pendingTargetsBySandbox.get(sandbox);
  return pending !== undefined && [...pending.values()].some((target) => target.buckets === null);
}

/**
 * Deploy each pending target's rules to the buckets `.firebaserc` maps it to
 * for `projectId`, the project the page's app config names. Only the first
 * project resolves, as RTDB targets resolve. Returns one notice per target.
 */
export function resolvePendingStorageTargets(sandbox: Sandbox, projectId: string | undefined): string[] {
  const hasProject = typeof projectId === 'string' && projectId !== '';
  if (!hasProject) return [];
  if (!appProjectBySandbox.has(sandbox)) appProjectBySandbox.set(sandbox, projectId);
  const pending = pendingTargetsBySandbox.get(sandbox);
  if (pending === undefined) return [];
  const isResolved = [...pending.values()].some((target) => target.buckets !== null);
  if (isResolved) return [];
  return [...pending.values()].map((target) => resolveTarget(sandbox, target, projectId));
}

/** Resolve one pending target with `projectId`, and the notice that says what it deploys to. */
function resolveTarget(sandbox: Sandbox, target: PendingTarget, projectId: string): string {
  const name = target.entry.target;
  const buckets = target.entry.bucketsByProject[projectId] ?? [];
  target.buckets = buckets;
  if (buckets.length === 0) {
    return `Storage deploy target "${name}" has no .firebaserc mapping for the app config project "${projectId}"; its buckets stay locked.`;
  }
  try {
    for (const bucket of buckets) deployStorageBucketRules(sandbox, bucket, target.entry.rules);
  } catch (error) {
    return `Storage deploy target "${name}" rules not loaded, so its buckets stay locked: ${error instanceof Error ? error.message : String(error)}`;
  }
  return `Storage deploy target "${name}" resolved with the app config project "${projectId}": its rules now apply to ${buckets.join(', ')}.`;
}

/**
 * The update a Node host deploy makes: `{ bucket }` names a bucket,
 * `{ target }` a pending deploy target, and nothing the default bucket.
 */
export function storageRulesUpdateFor(rules: string | null, destination: RulesDestination | undefined): StorageRulesUpdate {
  if (typeof destination === 'string') throw new Error('A Storage ruleset deploys to a bucket, not a database instance.');
  if (destination === undefined) return { rules };
  return 'bucket' in destination ? { rules, bucket: destination.bucket } : { rules, target: destination.target };
}

/** Apply one bucket's or one deploy target's rules change. */
export async function applyStorageRulesUpdate(sandbox: Sandbox, update: StorageRulesUpdate): Promise<void> {
  if (update.target !== undefined) {
    const pending = pendingTargetsBySandbox.get(sandbox)?.get(update.target);
    if (pending === undefined) return;
    // A source that does not compile throws before any bucket changes.
    for (const bucket of pending.buckets ?? []) deployStorageBucketRules(sandbox, bucket, update.rules);
    pending.entry.rules = update.rules;
    return;
  }
  await replaceStorageRules(sandbox, update.rules, update.bucket === undefined ? {} : { bucket: update.bucket });
}

/** What a served plane logs for one bucket's rules change. */
export function storageRulesUpdateNotice(update: StorageRulesUpdate): string {
  const file = storageUpdateSubject(update);
  if (update.rules === null) return `${file} removed; client Storage operations on it default to deny`;
  return `${file} hot-reloaded`;
}

function storageUpdateSubject(update: StorageRulesUpdate): string {
  if (update.target !== undefined) return `storage rules for deploy target ${update.target}`;
  if (update.bucket !== undefined) return `storage rules for bucket ${update.bucket}`;
  return 'storage.rules';
}
