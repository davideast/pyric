/**
 * Explicit, developer-confirmed seeding of the local hosted sandbox
 * (`.pyric/state/hosted`) from the data a Live mode session observed.
 *
 * Live mode refuses every ordinary write (`own-writes.ts`): Studio edits, MCP
 * write tools, CLI service commands and `--seed` startup files, so Pyric never
 * pretends to edit production or mirrors production values onto disk by
 * itself. This is the one way observed values reach disk, and only after the
 * developer confirms it (`POST /__pyric/live/seed-sandbox` with
 * `{ confirm: true }`, or `pyric sandbox seed-from-live --confirm`). It writes
 * with admin handles and silenced SDK activity, so the seed itself makes no
 * traffic rows, and Live mode's refusal of later writes stays as it was.
 *
 * Modes:
 * - `merge` keeps local data the session did not observe: each observed
 *   document is written with `setDoc(..., { merge: true })`, so fields only the
 *   local copy has stay, and each RTDB instance's observed tree is deep-merged
 *   onto the local one. A field production deleted but the session never saw
 *   deleted stays in the local copy.
 * - `replace` clears every local document and RTDB instance first, then
 *   writes the observed data as it is.
 *
 * Observed Cloud Storage entries (`snapshot.storage`) hold object metadata and
 * folder prefixes only (zero raw binary bytes), so seeding never fabricates
 * 0-byte placeholder blobs in `.pyric/state/hosted`.
 */
import { sdkActivity } from 'pyric/sandbox/internal';
import { deleteDoc, doc, getAdminFirestore, setDoc, type Firestore } from 'pyric/firestore';
import { snapshotDocuments } from 'pyric/sandbox/firestore';
import {
  getAdminDatabase,
  ref as databaseRef,
  remove as databaseRemove,
  sandbox as rtdbSandbox,
  set as databaseSet,
} from 'pyric/database';
import type { HostCtx } from '../worker/host.js';
import { rtdbInstance, rtdbInstances } from '../worker/host/rtdb-instances.js';
import { ensureGitignored } from '../capture-store.js';
import { rehydrateFirestoreDocData } from '../observed-session/rehydrate.js';
import { mergeRtdbTrees } from '../observed-session/rtdb-tree.js';
import type { LiveSeedMode, ObservedSessionDataSnapshot } from '../observed-session/wire.js';

export interface ObservedSeedResult {
  mode: LiveSeedMode;
  seededFirestoreDocs: number;
  seededRtdbInstances: string[];
}

export interface ObservedSeedRunnerHooks {
  readonly ctx: HostCtx;
  readonly ownedProjectDir: string;
  readonly isClosed: () => boolean;
  readonly isInOwnedProject: (callerProjectDir: string) => boolean;
  readonly requireHealthyPersistence: () => void;
  readonly restoreFirestoreSubscriptions: (ctx: HostCtx) => void;
  readonly flushPersistence: () => Promise<void>;
}

export interface ObservedSeedRunner {
  readonly pending: () => Promise<void>;
  run(
    snapshot: ObservedSessionDataSnapshot,
    options?: { mode?: LiveSeedMode; callerProjectDir?: string },
  ): Promise<ObservedSeedResult>;
}

async function clearLocalData(ctx: HostCtx, adminDb: Firestore): Promise<void> {
  for (const existingPath of Object.keys(snapshotDocuments(ctx.sandbox))) {
    await deleteDoc(doc(adminDb, existingPath));
  }
  await databaseRemove(databaseRef(getAdminDatabase(ctx.sandbox)));
  for (const [, instance] of rtdbInstances(ctx).entries()) {
    if (instance.selector === undefined) continue;
    await databaseRemove(databaseRef(getAdminDatabase(ctx.sandbox, instance.selector)));
  }
}

/** The selector of the local instance an observed instance name maps to, or undefined for the default. */
function selectorOf(ctx: HostCtx, instanceName: string): string | undefined {
  if (instanceName === 'default') return undefined;
  try {
    return rtdbInstance(ctx, instanceName).selector;
  } catch {
    return undefined;
  }
}

async function seedRtdbInstance(ctx: HostCtx, instanceName: string, observedTree: unknown, mode: LiveSeedMode): Promise<void> {
  const adminRtdb = getAdminDatabase(ctx.sandbox, selectorOf(ctx, instanceName));
  let nextTree = observedTree;
  if (mode === 'merge') nextTree = mergeRtdbTrees(rtdbSandbox.snapshotState(adminRtdb), observedTree);
  if (nextTree === null || nextTree === undefined) return;
  await databaseSet(databaseRef(adminRtdb, '/'), nextTree as never);
}

/** Writes the snapshot into the local sandbox; the caller flushes persistence and restores listeners. */
export async function seedFromObservedSession(
  ctx: HostCtx,
  snapshot: ObservedSessionDataSnapshot,
  mode: LiveSeedMode,
): Promise<ObservedSeedResult> {
  const result: ObservedSeedResult = { mode, seededFirestoreDocs: 0, seededRtdbInstances: [] };
  await sdkActivity.silence(async () => {
    const adminDb = getAdminFirestore(ctx.sandbox);
    if (mode === 'replace') await clearLocalData(ctx, adminDb);
    const merge = mode === 'merge';
    for (const [docPath, rawDoc] of Object.entries(snapshot.firestore)) {
      await setDoc(doc(adminDb, docPath), rehydrateFirestoreDocData(adminDb, rawDoc), { merge });
      result.seededFirestoreDocs += 1;
    }
    for (const [instanceName, observedTree] of Object.entries(snapshot.rtdb)) {
      await seedRtdbInstance(ctx, instanceName, observedTree, mode);
      result.seededRtdbInstances.push(instanceName);
    }
  });
  return result;
}

/** Serializes confirmed observed-session seeds onto one queue for `createHostedRuntime`. */
export function createObservedSeedRunner(hooks: ObservedSeedRunnerHooks): ObservedSeedRunner {
  let seedWork = Promise.resolve();
  return {
    pending: () => seedWork,
    run(snapshot, options = {}) {
      if (hooks.isClosed()) return Promise.reject(new Error('The hosted sandbox is closed.'));
      const callerProjectDir = options.callerProjectDir ?? hooks.ownedProjectDir;
      if (!hooks.isInOwnedProject(callerProjectDir)) {
        return Promise.reject(new Error('The discovered host belongs to another project.'));
      }
      const mode = options.mode ?? 'merge';
      const queued = seedWork.then(async () => {
        if (hooks.isClosed()) throw new Error('The hosted sandbox is closed.');
        hooks.requireHealthyPersistence();
        ensureGitignored(hooks.ownedProjectDir);
        const seeded = await seedFromObservedSession(hooks.ctx, snapshot, mode);
        hooks.restoreFirestoreSubscriptions(hooks.ctx);
        await hooks.flushPersistence();
        return seeded;
      });
      seedWork = queued.then(() => {}, () => {});
      return queued;
    },
  };
}
