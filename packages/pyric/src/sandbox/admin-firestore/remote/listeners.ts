/**
 * Remote-arm `onSnapshot` plumbing: the hidden registrar hook every
 * remote ref/query exposes, the chainable `.onSnapshot(...)` shim that
 * late-binds to the free `onSnapshot` function, and the worker
 * subscription that adapts wire snap frames into Web-SDK-shaped live
 * snapshots.
 */

import { SandboxError } from 'pyric/sandbox';
import type { DocumentData } from 'pyric/sandbox/admin-compat';
import {
  buildDocumentSnapshot,
  buildQuerySnapshot,
} from '../../firestore/snapshot-listeners.js';
import { toRemoteSandboxError } from './errors.js';
import { decodeInternal } from './value-codec.js';
import type { RemoteArm } from './channel.js';
import type { WireDocSnap, WireQuerySnap, WireTarget } from './wire-types.js';

/**
 * Hidden hook the free `onSnapshot(ref, …)` in `../listeners.ts`
 * dispatches on: every remote ref/query exposes a registrar under this
 * symbol that takes the NORMALIZED argument set and returns the
 * unsubscribe. `Symbol.for` is unnecessary here (single module graph
 * inside `pyric`), but a plain unique symbol keeps it invisible to
 * consumer code.
 */
export const REMOTE_SNAPSHOT_REGISTRAR: unique symbol = Symbol(
  'pyric/sandbox/admin-firestore/remoteSnapshotRegistrar',
);

export type RemoteSnapshotRegistrar = (
  options: { includeMetadataChanges?: boolean },
  onNext: ((snapshot: unknown) => void) | undefined,
  onError: ((error: unknown) => void) | undefined,
) => () => void;

/** Is this ref one of the remote arm's (carries the registrar hook)? */
export function getRemoteSnapshotRegistrar(ref: unknown): RemoteSnapshotRegistrar | undefined {
  if (ref === null || typeof ref !== 'object') return undefined;
  const registrar = (ref as { [REMOTE_SNAPSHOT_REGISTRAR]?: unknown })[REMOTE_SNAPSHOT_REGISTRAR];
  return typeof registrar === 'function' ? (registrar as RemoteSnapshotRegistrar) : undefined;
}

/**
 * Late-bound reference to the free `onSnapshot` from `../listeners.ts`,
 * backing the chainable `ref.onSnapshot(...)` method on remote refs
 * (parity with the local arm's Proxy-synthesized shim). Registered at
 * module init from `../listeners.ts` — a static import back would be a
 * cycle at runtime.
 */
type FreeOnSnapshot = (ref: unknown, ...args: unknown[]) => () => void;
let freeOnSnapshot: FreeOnSnapshot | null = null;

export function registerRemoteOnSnapshotImpl(fn: FreeOnSnapshot): void {
  freeOnSnapshot = fn;
}

export function chainableOnSnapshot(this: unknown, ...args: unknown[]): () => void {
  if (freeOnSnapshot === null) {
    throw new SandboxError(
      'failed-precondition',
      'remote Firestore: onSnapshot is not wired yet — import pyric-admin/firestore (or pyric/sandbox/admin-firestore) before subscribing.',
    );
  }
  return freeOnSnapshot(this, ...args);
}

/** Register a worker subscription for a resolved target and adapt snap
 *  frames into the Web-SDK-shaped live snapshots the local `onSnapshot`
 *  delivers. Wire `__error` snaps (establishment AND mid-stream, e.g. a
 *  rules redeploy turning the read into a denial) surface through
 *  `onError` as `SandboxError`s with `denialContext` when carried. */
export function registerRemoteListener(
  arm: RemoteArm,
  target: WireTarget,
  options: { includeMetadataChanges?: boolean },
  onNext: ((snapshot: unknown) => void) | undefined,
  onError: ((error: unknown) => void) | undefined,
): () => void {
  const excludesMetadataChanges = options.includeMetadataChanges !== true;
  // Previous query rows, kept so `docChanges()` diffs across fires the
  // same way the local listener path does.
  let prevDocs: Array<{ path: string; data: DocumentData }> | undefined;

  let detach: () => void;
  try {
    detach = arm.sandbox.channel.subscribe(
      { target, actAs: arm.lens },
      (value) => {
        if (!onNext) return;
        const snap = value as Partial<WireDocSnap> & Partial<WireQuerySnap>;
        if (Array.isArray(snap.docs)) {
          // Query fire. `buildQuerySnapshot` translates the internal-form
          // data to compat shapes itself, so decode WITHOUT translation.
          const docList = snap.docs.map((row) => ({
            path: row.path ?? row.id,
            data: row.data ? decodeInternal(row.data) : {},
          }));
          const queryPath = target.__ref === 'query'
            ? (target.source.__ref === 'group' ? target.source.collectionId : target.source.path)
            : target.__ref === 'group'
              ? target.collectionId
              : target.path;
          const querySnap = buildQuerySnapshot(
            { path: queryPath },
            docList,
            { excludesMetadataChanges },
            prevDocs,
          );
          prevDocs = docList;
          onNext(querySnap);
        } else if (typeof snap.id === 'string') {
          // Doc fire.
          const path = snap.path ?? snap.id;
          const data = snap.exists && snap.data ? decodeInternal(snap.data) : null;
          onNext(buildDocumentSnapshot(path, data));
        }
      },
      (err) => {
        const translated = toRemoteSandboxError(err);
        if (onError) onError(translated);
        else console.error('pyric remote Firestore: uncaught onSnapshot error:', translated);
      },
    );
  } catch (e) {
    throw toRemoteSandboxError(e);
  }
  return detach;
}
