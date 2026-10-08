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
import { sandbox as rtdbSandbox } from 'pyric/database';
import { cliVersion } from '../../pkg-version.js';
import type { HostCtx, PortLike } from '../worker/host-context.js';
import { portSession } from '../worker/host-auth.js';
import { rtdbInstances } from '../worker/host/rtdb-instances.js';
import { UNNAMED_DEFAULT_DATABASE_INSTANCE } from 'pyric/sandbox/internal';
import { REPRO_SCHEMA, redactSecrets, type ReproBase, type ReproDatabaseRules, type ReproFile, type ReproPortSession } from './format.js';
import type { ReproLog } from './recorder.js';

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
    databaseInstances[name] = rtdbSandbox.snapshotState(entry.live);
  }
  // The default instance's tree and rules are the checkpoint's.
  database[defaultInstance] = checkpoint.state.rules.database;
  const sessions: Record<string, ReproPortSession> = {};
  for (const [id, port] of ports) {
    const session = portSession(ctx, port);
    if (session) sessions[id] = { uid: session.user.uid, tenantId: session.state.tenant ?? null };
  }
  const firestore = enforced(ctx.activeRules?.firestore);
  return {
    at: Date.now(),
    checkpoint,
    databaseInstances,
    rules: {
      firestore: typeof firestore === 'string' ? firestore : checkpoint.state.rules.firestore || null,
      database,
      storage: checkpoint.state.rules.storage,
    },
    defaultInstance,
    permissive: ctx.rtdbDefaultPolicy === 'allow',
    appOptions: ctx.appOptions ? structuredClone(ctx.appOptions) as Record<string, unknown> : null,
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

/** The repro file for a recorded log: JSON only, secrets removed, Storage bytes inline. */
export async function buildReproFile(log: ReproLog, objectFile: ObjectFileLookup): Promise<ReproFile> {
  const base = await inlineStorage(log.base, objectFile);
  const file: ReproFile = {
    schema: REPRO_SCHEMA,
    createdAt: new Date().toISOString(),
    recordedBy: cliVersion(),
    truncated: log.truncated,
    base,
    entries: log.entries,
  };
  return redactSecrets(JSON.parse(JSON.stringify(file))) as ReproFile;
}
