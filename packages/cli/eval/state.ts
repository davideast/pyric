/**
 * Reading a finished run back. Loads the snapshot the in-process server flushed
 * on stdio close into a fresh sandbox, reads the events NDJSON, and exposes the
 * `EvalState` a task's `assert` receives.
 *
 * Reads go through admin handles so a task's assertion measures what is stored,
 * not what the run's rules would have allowed a reader to see.
 */
import { existsSync, readFileSync } from 'node:fs';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { getAdminFirestore, doc, getDoc } from 'pyric/firestore';
import { getAdminDatabase, ref as databaseRef, get as databaseGet } from 'pyric/database';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { ref as storageRef, getMetadata } from 'pyric/storage';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { loadSandboxSnapshot } from '../src/bridge/server/in-process.js';
import { listStoredPaths, loadStorageSidecar } from './storage-sidecar.js';
import type { EvalCall, EvalEvent, EvalState } from './types.js';

/**
 * Load the run's persisted state in `dir` into a fresh sandbox.
 *
 * `loadSnapshot` restores only services that are already registered, so each
 * service is opened before the snapshot is applied. Storage is restored from
 * its own sidecar, which is where the eval keeps state the v3 bundle does not
 * carry.
 */
export async function loadRunSandbox(dir: string): Promise<LocalSandbox> {
  const sandbox = initializeSandbox();
  getAuth(sandbox);
  getAdminDatabase(sandbox);
  const storage = getAdminStorageSandbox(sandbox);
  loadSandboxSnapshot(sandbox, dir);
  await loadStorageSidecar(storage, dir);
  return sandbox;
}

/** Parse the events NDJSON into the call log a task's assertion sees. */
export function readCalls(eventsPath: string): EvalCall[] {
  return readEvents(eventsPath).map((event) => ({
    operation: event.operation ?? null,
    tool: event.tool,
    ok: event.result?.ok === true,
    // A log written before the field existed carries no verdict, and a call
    // that reported one is the exception, so absence reads as false.
    verdict: event.verdict === true,
    schemaRejected: event.schemaRejected === true,
    args: event.args ?? {},
    data: event.result?.data,
  }));
}

/** Every event in the log, ordered as written. Used by the scorer, not by tasks. */
export function readEvents(eventsPath: string): EvalEvent[] {
  if (!existsSync(eventsPath)) return [];
  const events: EvalEvent[] = [];
  for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    events.push(JSON.parse(trimmed) as EvalEvent);
  }
  return events;
}

/**
 * A snapshot's existence flag. The modular surface exposes it as a method and
 * the chainable one as a property, so both spellings are accepted here rather
 * than pinning the eval to one of them.
 */
function snapshotExists(snap: { exists: boolean | (() => boolean) }): boolean {
  if (typeof snap.exists === 'function') return snap.exists();
  return snap.exists;
}

/** Every stored document, keyed by path, read through the rules-bypassing handle. */
async function readDocuments(
  sandbox: LocalSandbox,
): Promise<Map<string, Record<string, unknown>>> {
  const documents = new Map<string, Record<string, unknown>>();
  const db = getAdminFirestore(sandbox);
  for (const path of Object.keys(sandbox.snapshot().firestore)) {
    // A snapshot can hold keys that are not document paths (an agent seeding a
    // raw snapshot can put anything there). Those are not documents a task can
    // assert on, so they are skipped rather than allowed to abort the read.
    if (path.split('/').length % 2 !== 0) continue;
    const snap = await getDoc(doc(db, path));
    if (!snapshotExists(snap)) continue;
    documents.set(path, snap.data() as Record<string, unknown>);
  }
  return documents;
}

/**
 * One listing per collection that holds at least one stored document, derived
 * from the documents already read. A collection listing is a projection of the
 * same state, so it does not warrant a second round of queries.
 */
function readListings(
  documents: Map<string, Record<string, unknown>>,
): Map<string, Array<{ id: string; data: Record<string, unknown> }>> {
  const listings = new Map<string, Array<{ id: string; data: Record<string, unknown> }>>();
  for (const [path, data] of documents) {
    const cut = path.lastIndexOf('/');
    const parent = path.slice(0, cut);
    const id = path.slice(cut + 1);
    const existing = listings.get(parent);
    if (existing === undefined) {
      listings.set(parent, [{ id, data }]);
      continue;
    }
    existing.push({ id, data });
  }
  for (const entries of listings.values()) {
    entries.sort((a, b) => a.id.localeCompare(b.id));
  }
  return listings;
}

/** Every stored identity, projected to the fields a task may assert on. */
function readUsers(
  sandbox: LocalSandbox,
): Map<string, { uid: string; email?: string; claims: Record<string, unknown>; tenant?: string }> {
  const auth = getAuth(sandbox);
  // The record list carries claims but not the tenant, and the export carries
  // the tenant but skips anonymous identities, so the view joins both.
  const exported = new Map(authSandbox.exportUsers(auth).map((user) => [user.uid, user]));
  const users = new Map<
    string,
    { uid: string; email?: string; claims: Record<string, unknown>; tenant?: string }
  >();
  for (const record of authSandbox.listUsers(auth)) {
    const view: { uid: string; email?: string; claims: Record<string, unknown>; tenant?: string } = {
      uid: record.uid,
      claims: record.customClaims ?? {},
    };
    if (typeof record.email === 'string') view.email = record.email;
    const tenant = exported.get(record.uid)?.tenantId;
    if (tenant !== undefined) view.tenant = tenant;
    users.set(record.uid, view);
  }
  return users;
}

/** Every stored object, projected to content type, size and custom metadata. */
async function readObjects(
  sandbox: LocalSandbox,
): Promise<
  Map<string, { contentType?: string; size: number; metadata: Record<string, unknown> }>
> {
  const storage = getAdminStorageSandbox(sandbox);
  const objects = new Map<
    string,
    { contentType?: string; size: number; metadata: Record<string, unknown> }
  >();
  for (const path of await listStoredPaths(storage)) {
    const metadata = await getMetadata(storageRef(storage, path));
    const view: { contentType?: string; size: number; metadata: Record<string, unknown> } = {
      size: metadata.size,
      metadata: metadata.customMetadata ?? {},
    };
    if (metadata.contentType !== undefined) view.contentType = metadata.contentType;
    objects.set(path, view);
  }
  return objects;
}

/**
 * Build the `EvalState` for a finished run. Everything is read once, up front,
 * so the accessors a task's `assert` calls are synchronous.
 */
/** A state with nothing in it, for a run the harness could not carry out. */
export function emptyEvalState(): EvalState {
  return {
    firestore: { get: () => null, list: () => [] },
    database: { get: () => undefined },
    users: { get: () => null, list: () => [] },
    storage: { get: () => null },
    calls: [],
  };
}

export async function buildEvalState(dir: string, eventsPath: string): Promise<EvalState> {
  const sandbox = await loadRunSandbox(dir);
  const documents = await readDocuments(sandbox);
  const listings = readListings(documents);
  const users = readUsers(sandbox);
  const objects = await readObjects(sandbox);

  const rtdb = getAdminDatabase(sandbox);
  const databaseRoot = (await databaseGet(databaseRef(rtdb, '/'))).val() as unknown;

  return {
    firestore: {
      get: (path) => documents.get(path) ?? null,
      list: (path) => listings.get(path) ?? [],
    },
    database: { get: (path) => resolveDatabasePath(databaseRoot, path) },
    users: {
      get: (uid) => users.get(uid) ?? null,
      list: () => [...users.keys()].map((uid) => ({ uid })),
    },
    storage: { get: (path) => objects.get(path) ?? null },
    calls: readCalls(eventsPath),
  };
}

/** Walk a slash-delimited database path into the loaded tree. */
function resolveDatabasePath(root: unknown, path: string): unknown {
  let node = root;
  for (const segment of path.split('/')) {
    if (segment.length === 0) continue;
    if (node === null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[segment];
    if (node === undefined) return null;
  }
  return node ?? null;
}
