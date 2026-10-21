/**
 * SharedWorker host: rolling back a canceled upload's own write (#1157, #1159).
 *
 * pyric stores a resumable upload's object when its commit lands, which can
 * be after the task was canceled. Production never stores a canceled upload,
 * so the path keeps whatever was there, and its rules never see a delete for
 * one. A commit that asks (`rollback: true` on `storage.putBytes` or
 * `storage.finishUpload`) gets a token instead. The host binds it to the
 * client that sent the commit, to the bucket, path, and generation the commit
 * stored, and to the object that commit replaced, as its write returned it.
 * `storage.rollbackUpload` redeems it once, without evaluating rules: it puts
 * the replaced object back, or deletes the commit's object when it replaced
 * none, and does neither when a later write replaced that generation. A token
 * from another client, an expired one, or one already used is refused.
 *
 * This token is a fidelity mechanism, not a security control. Rules in pyric
 * govern what the Firebase SDK calls do; a client that speaks the worker
 * protocol directly can already send `actAs: { mode: 'admin' }` and skip
 * them. The token keeps an SDK client's rollback to its own commit, so a
 * cancel cannot undo another client's write.
 */
import { FirebaseError } from 'pyric/app';
import type { EventProvenance } from 'pyric/sandbox';
import type { StorageReference } from 'pyric/storage';
import {
  getStorageService, keepReplacedObject, undoCanceledCommit, type ReplacedAtCommit, type StoredObject,
} from 'pyric/storage/internal';
import type { HostCtx, PortLike } from '../host-context.js';
import { mintCapabilityToken } from '../protocol.js';

/** The object generation one commit stored. */
export interface CommittedObject {
  /** The bucket the object is stored in, as the host stores it. */
  readonly bucket: string;
  readonly path: string;
  readonly generation: string;
}

/** A commit's object and what it replaced, which a rollback puts back. */
export interface RollbackTarget extends CommittedObject {
  readonly replaced: ReplacedAtCommit;
}

interface RollbackGrant extends RollbackTarget {
  readonly expiresAt: number;
  /** The bytes the kept object holds in memory; a reference holds none. */
  readonly keptBytes: number;
}

/**
 * How long a token stays valid. A paused task holds its commit's outcome
 * until it is resumed or canceled, so the token outlives a short pause; after
 * this, a cancel falls back to a delete the rules decide.
 */
export const ROLLBACK_GRANT_TTL_MS = 60 * 60 * 1000;

/** The most tokens one client holds; issuing past this drops the oldest. */
const MAX_GRANTS_PER_CLIENT = 64;

/**
 * The most bytes of kept objects one client's tokens hold in memory; issuing
 * past this drops the oldest. A successful upload never redeems its token, so
 * the oldest are almost always spent. A backend that keeps bytes in files
 * (the Node host) keeps references, which hold none. An object larger than
 * this is not kept: canceling the commit that replaced it leaves the upload's
 * object in place and rejects with the failed restore.
 */
export const MAX_KEPT_BYTES_PER_CLIENT = 64 * 1024 * 1024;

/**
 * Each client's tokens, by the port its calls arrive on. A remote client
 * session has one port of its own (`RemoteClientPort`), so sessions sharing a
 * physical port never see each other's tokens.
 */
const grantsByHost = new WeakMap<HostCtx, WeakMap<PortLike, Map<string, RollbackGrant>>>();

function grantsOf(ctx: HostCtx, port: PortLike): Map<string, RollbackGrant> {
  let byPort = grantsByHost.get(ctx);
  if (byPort === undefined) {
    byPort = new WeakMap();
    grantsByHost.set(ctx, byPort);
  }
  let grants = byPort.get(port);
  if (grants === undefined) {
    grants = new Map();
    byPort.set(port, grants);
  }
  return grants;
}

function dropExpired(grants: Map<string, RollbackGrant>, now: number): void {
  for (const [token, grant] of grants) {
    const expired = grant.expiresAt <= now;
    if (expired) grants.delete(token);
  }
}

/** Token maps with an expiry sweep scheduled. */
const sweepScheduled = new WeakSet<Map<string, RollbackGrant>>();

/**
 * Drop a client's tokens as they expire, so a client that never commits or
 * rolls back again does not hold its kept objects past their lifetime. The
 * timer does not keep a Node process alive.
 */
function scheduleExpirySweep(grants: Map<string, RollbackGrant>): void {
  const oldest = grants.values().next().value;
  const nothingToSweep = oldest === undefined || sweepScheduled.has(grants);
  if (nothingToSweep) return;
  sweepScheduled.add(grants);
  const timer = setTimeout(() => {
    sweepScheduled.delete(grants);
    dropExpired(grants, Date.now());
    scheduleExpirySweep(grants);
  }, Math.max(0, oldest.expiresAt - Date.now()));
  (timer as { unref?: () => void }).unref?.();
}

function keptBytesIn(grants: Map<string, RollbackGrant>): number {
  let total = 0;
  for (const grant of grants.values()) total += grant.keptBytes;
  return total;
}

/** Drop the oldest tokens until one more, holding `incoming` bytes, fits. */
function dropOldestPastLimit(grants: Map<string, RollbackGrant>, incoming: number): void {
  let kept = keptBytesIn(grants);
  for (const [token, oldest] of grants) {
    const tooMany = grants.size >= MAX_GRANTS_PER_CLIENT;
    const tooLarge = kept + incoming > MAX_KEPT_BYTES_PER_CLIENT;
    const fits = !tooMany && !tooLarge;
    if (fits) return;
    kept -= oldest.keptBytes;
    grants.delete(token);
  }
}

function keptBytesFor(target: RollbackTarget): number {
  const replaced = target.replaced;
  if (replaced.kind !== 'kept') return 0;
  return replaced.heldBytes;
}

/** Issue the token that rolls back `target`, for the client on `port` only. */
function issueRollbackGrant(ctx: HostCtx, port: PortLike, target: RollbackTarget): string {
  const grants = grantsOf(ctx, port);
  const now = Date.now();
  const keptBytes = keptBytesFor(target);
  dropExpired(grants, now);
  dropOldestPastLimit(grants, keptBytes);
  const token = mintCapabilityToken();
  grants.set(token, { ...target, expiresAt: now + ROLLBACK_GRANT_TTL_MS, keptBytes });
  scheduleExpirySweep(grants);
  return token;
}

/**
 * The reply fields a commit adds when it asked for a rollback token: the
 * token, and `replacedObject` when the commit replaced an object, so a client
 * whose token is refused knows a delete would not undo it.
 */
export function rollbackReceipt(
  ctx: HostCtx,
  port: PortLike,
  asked: boolean | undefined,
  target: RollbackTarget,
): { rollbackToken?: string; replacedObject?: true } {
  const wantsToken = asked === true;
  if (!wantsToken) return {};
  const rollbackToken = issueRollbackGrant(ctx, port, target);
  const replacedObject = target.replaced.kind !== 'none';
  if (replacedObject) return { rollbackToken, replacedObject };
  return { rollbackToken };
}

/**
 * Take what a token rolls back, once; the kept object goes with it. Refused
 * unless this client was issued the token, it has not expired, and it was not
 * used before.
 */
export function redeemRollbackGrant(ctx: HostCtx, port: PortLike, token: string): RollbackTarget {
  const grants = grantsOf(ctx, port);
  const grant = grants.get(token);
  grants.delete(token);
  dropExpired(grants, Date.now());
  const isLive = grant !== undefined && grant.expiresAt > Date.now();
  if (!isLive) {
    throw new FirebaseError(
      'storage/unauthorized',
      'This rollback token was not issued to this client, has expired, or was used already. Delete the object instead; the rules decide that delete.',
    );
  }
  const { expiresAt: _expiresAt, keptBytes: _keptBytes, ...target } = grant;
  return target;
}

/**
 * The object a commit replaced, kept for its rollback token when the commit
 * asked for one. `replaced` is what the backend's write returned, read in the
 * same transaction, so no other write can land between the read and the commit.
 */
export async function replacedForRollback(
  target: StorageReference,
  asked: boolean | undefined,
  replaced: StoredObject | undefined,
): Promise<ReplacedAtCommit> {
  const wantsToken = asked === true;
  if (!wantsToken) return { kind: 'none' };
  return keepReplacedObject(target, replaced, MAX_KEPT_BYTES_PER_CLIENT);
}

/** The object a rollback puts back, or undefined when the commit replaced none. */
function keptPrior(replaced: ReplacedAtCommit): StoredObject | undefined {
  if (replaced.kind === 'kept') return replaced.object;
  return undefined;
}

/**
 * Roll back one redeemed commit at `target`, failing with the cause when the
 * rollback fails. An object too large to keep cannot be put back, and
 * deleting the upload's object would lose both, so that rollback fails too,
 * unless a later write has already replaced the commit.
 */
export async function rollBackCommit(target: StorageReference, committed: RollbackTarget, provenance: EventProvenance | undefined): Promise<{ deleted: boolean; restored: boolean }> {
  const replaced = committed.replaced;
  if (replaced.kind === 'too-large') return refuseUnkeptRestore(target, committed.generation, replaced.size);
  const commit = { generation: committed.generation, prior: keptPrior(replaced) };
  const { deleted, restored, error } = await undoCanceledCommit(target, commit, provenance);
  // The client words the failure; send the cause, not the wrapped error.
  if (error !== undefined) throw error.cause ?? error;
  return { deleted, restored };
}

async function refuseUnkeptRestore(target: StorageReference, generation: string, size: number): Promise<{ deleted: boolean; restored: boolean }> {
  const service = await getStorageService(target.storage);
  const existing = await service.backend.getMetadata(target.fullPath);
  const laterWriteKept = existing?.generation !== generation;
  if (laterWriteKept) return { deleted: false, restored: false };
  throw new FirebaseError(
    'storage/unknown',
    `The object at '${target.fullPath}' that this upload replaced (${size} bytes) was too large to keep for a rollback, so it cannot be restored.`,
  );
}
