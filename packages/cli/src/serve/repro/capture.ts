/**
 * Read the Node host's starting state for the repro log, and turn the log into
 * a self-contained repro file.
 *
 * The starting state reuses the checkpoint capture. Storage is read by
 * reference, so opening a log window copies no object bytes; the bytes are
 * read from the host's object files only when a repro file is written.
 */
import { readFile } from 'node:fs/promises';
import { captureCheckpoint } from 'pyric/sandbox/checkpoints';
import { get as rtdbGet, getAdminDatabase, ref as rtdbRef } from 'pyric/database';
import { sdkActivity, UNNAMED_DEFAULT_DATABASE_INSTANCE } from 'pyric/sandbox/internal';
import { cliVersion } from '../../pkg-version.js';
import type { HostCtx, PortLike } from '../worker/host-context.js';
import { portSession } from '../worker/host-auth.js';
import { rtdbInstances } from '../worker/host/rtdb-instances.js';
import { REPRO_SCHEMA, redactSecrets, type ReproBase, type ReproDatabaseRules, type ReproEntry, type ReproFile, type ReproPortSession } from './format.js';
import type { ReproLog } from './recorder.js';

const STANDARD_TOKEN_CLAIMS = new Set([
  'firebase', 'uid', 'user_id', 'sub', 'iss', 'aud', 'iat', 'exp',
  'auth_time', 'email', 'email_verified', 'phone_number', 'name', 'picture', 'nonce',
]);

/** The ruleset an instance or service enforces: the active one, or the last good one when a deploy was refused. */
function enforced(rules: { status: 'active' | 'error'; source: unknown; lastKnownGood?: unknown } | undefined): unknown {
  if (rules === undefined) return null;
  return rules.status === 'active' ? rules.source : rules.lastKnownGood ?? null;
}

/** Read everything the host holds that a replay starts from. */
export async function captureReproBase(
  ctx: HostCtx,
  ports: Iterable<[string, PortLike]>,
): Promise<Omit<ReproBase, 'subscriptions'>> {
  const checkpoint = await captureCheckpoint(ctx.sandbox, { storage: 'reference' });
  const registry = rtdbInstances(ctx);
  const defaultInstance = ctx.defaultRtdbInstance ?? UNNAMED_DEFAULT_DATABASE_INSTANCE;
  const databaseInstances: Record<string, unknown> = {};
  const database: ReproDatabaseRules = {};
  for (const [key, entry] of registry.entries()) {
    const isDefault = key === registry.defaultKey;
    const name = isDefault ? defaultInstance : key;
    if (isDefault) continue;
    database[name] = enforced(entry.rules) as ReproDatabaseRules[string];
    const adminDb = getAdminDatabase(ctx.sandbox, entry.selector);
    const snap = await sdkActivity.silence(() => rtdbGet(rtdbRef(adminDb, '/')));
    databaseInstances[name] = snap.exportVal();
  }
  // The default instance's tree and rules are the checkpoint's.
  database[defaultInstance] = checkpoint.state.rules.database;
  const sessions: Record<string, ReproPortSession> = {};
  for (const [id, port] of ports) {
    const session = portSession(ctx, port);
    if (session) {
      const token = session.state.token as Record<string, unknown> | undefined;
      const firebaseClaim = token?.firebase as { sign_in_provider?: unknown } | undefined;
      const signInProvider = typeof firebaseClaim?.sign_in_provider === 'string' ? firebaseClaim.sign_in_provider : undefined;
      const customClaims: Record<string, unknown> = {};
      if (token) {
        for (const [claim, val] of Object.entries(token)) {
          if (!STANDARD_TOKEN_CLAIMS.has(claim)) customClaims[claim] = val;
        }
      }
      sessions[id] = {
        uid: session.user.uid,
        tenantId: session.state.tenant ?? null,
        ...(signInProvider !== undefined ? { signInProvider } : {}),
        ...(Object.keys(customClaims).length > 0 ? { customClaims } : {}),
      };
    }
  }
  const firestore = enforced(ctx.activeRules?.firestore);
  return {
    at: Date.now(),
    checkpoint,
    databaseInstances,
    rules: {
      firestore: typeof firestore === 'string' ? firestore : null,
      database,
      storage: checkpoint.state.rules.storage,
    },
    defaultInstance,
    permissive: ctx.rtdbDefaultPolicy === 'allow',
    appOptions: ctx.appOptions ? structuredClone(ctx.appOptions) as Record<string, unknown> : null,
    messaging: ctx.messagingEnabled === true,
    sessions,
  };
}

/** Where the host keeps the bytes of the object with this hash, or undefined when it does not. */
export type ObjectFileLookup = (sha256: string) => string | undefined;

/** Carry each Storage object's bytes inline, so the file replays on another machine. */
async function inlineStorage(base: ReproBase, objectFile: ObjectFileLookup): Promise<ReproBase> {
  const storage = [];
  for (const object of base.checkpoint.state.storage) {
    const isReference = 'sha256' in object;
    if (!isReference) {
      storage.push(object);
      continue;
    }
    const file = objectFile(object.sha256);
    if (file === undefined) {
      throw new Error(`The bytes of Storage object '${object.path}' (${object.sha256}) are no longer on disk; the repro cannot carry them.`);
    }
    const { sha256: _sha256, size: _size, ...fields } = object;
    storage.push({ ...fields, contentBase64: (await readFile(file)).toString('base64') });
  }
  const state = { ...base.checkpoint.state, storage };
  return { ...base, checkpoint: { ...base.checkpoint, state } };
}

/** Read a recorded byte-route upload slice back from its staging file when writing a repro. */
export type UploadSliceLookup = (uploadId: string, offset: number, length: number) => Promise<Uint8Array>;

/** The repro file for a recorded log: JSON only, secrets removed, Storage bytes inline. */
export async function buildReproFile(
  log: ReproLog,
  objectFile: ObjectFileLookup,
  uploadSlice?: UploadSliceLookup,
): Promise<ReproFile> {
  const base = await inlineStorage(log.base, objectFile);
  const entries: ReproEntry[] = [];
  for (const entry of log.entries) {
    if (entry.kind === 'upload-slice') {
      if (uploadSlice === undefined) {
        throw new Error(`The bytes of Storage upload '${entry.uploadId}' are no longer on disk; the repro cannot carry them.`);
      }
      const bytes = await uploadSlice(entry.uploadId, entry.offset, entry.length);
      entries.push({
        kind: 'upload',
        at: entry.at,
        uploadId: entry.uploadId,
        partIndex: entry.partIndex,
        offset: entry.offset,
        dataB64: Buffer.from(bytes).toString('base64'),
      });
    } else {
      entries.push(entry);
    }
  }
  const file: ReproFile = {
    schema: REPRO_SCHEMA,
    createdAt: new Date().toISOString(),
    recordedBy: cliVersion(),
    truncated: log.truncated,
    base,
    entries,
  };
  return redactSecrets(JSON.parse(JSON.stringify(file))) as ReproFile;
}
