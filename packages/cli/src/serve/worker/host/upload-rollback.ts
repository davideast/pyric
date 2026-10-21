/**
 * SharedWorker host: rolling back a canceled upload's own write (#1157).
 *
 * pyric stores a resumable upload's object when its commit lands, which can
 * be after the task was canceled. Production never stores a canceled upload,
 * so its rules never see a delete for one, and a rules-checked rollback fails
 * under rules that allow the create and deny the delete. A commit that asks
 * (`rollback: true` on `storage.putBytes` or `storage.finishUpload`) gets a
 * token instead. The host binds it to the client that sent the commit and to
 * the bucket, path, and generation the commit stored. `storage.rollbackUpload`
 * redeems it once: it deletes that generation without evaluating rules, or
 * deletes nothing when a later write replaced it. A token from another
 * client, an expired one, or one already used is refused.
 */
import { FirebaseError } from 'pyric/app';
import type { HostCtx, PortLike } from '../host-context.js';
import { mintCapabilityToken } from '../protocol.js';

/** The object generation one commit stored. */
export interface CommittedObject {
  /** The bucket the object is stored in, as the host stores it. */
  readonly bucket: string;
  readonly path: string;
  readonly generation: string;
}

interface RollbackGrant extends CommittedObject {
  readonly expiresAt: number;
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

function dropOldestPastLimit(grants: Map<string, RollbackGrant>): void {
  while (grants.size >= MAX_GRANTS_PER_CLIENT) {
    const oldest = grants.keys().next().value;
    if (oldest === undefined) return;
    grants.delete(oldest);
  }
}

/** Issue the token that rolls back `object`, for the client on `port` only. */
function issueRollbackGrant(ctx: HostCtx, port: PortLike, object: CommittedObject): string {
  const grants = grantsOf(ctx, port);
  const now = Date.now();
  dropExpired(grants, now);
  dropOldestPastLimit(grants);
  const token = mintCapabilityToken();
  grants.set(token, { bucket: object.bucket, path: object.path, generation: object.generation, expiresAt: now + ROLLBACK_GRANT_TTL_MS });
  return token;
}

/** The reply field a commit adds when it asked for a rollback token. */
export function rollbackReceipt(
  ctx: HostCtx,
  port: PortLike,
  asked: boolean | undefined,
  object: CommittedObject,
): { rollbackToken?: string } {
  const wantsToken = asked === true;
  if (!wantsToken) return {};
  return { rollbackToken: issueRollbackGrant(ctx, port, object) };
}

/**
 * Take the object a token rolls back, once. Refused unless this client was
 * issued the token, it has not expired, and it was not used before.
 */
export function redeemRollbackGrant(ctx: HostCtx, port: PortLike, token: string): CommittedObject {
  const grants = grantsOf(ctx, port);
  const grant = grants.get(token);
  grants.delete(token);
  const isLive = grant !== undefined && grant.expiresAt > Date.now();
  if (!isLive) {
    throw new FirebaseError(
      'storage/unauthorized',
      'This rollback token was not issued to this client, has expired, or was used already. Delete the object instead; the rules decide that delete.',
    );
  }
  return { bucket: grant.bucket, path: grant.path, generation: grant.generation };
}
