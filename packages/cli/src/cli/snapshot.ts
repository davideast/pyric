/**
 * `pyric snapshot` — promote lived sandbox state to a committable fixture
 * (flow doc section 3c: seed.json is intent, `.pyric/state/` is runtime, promote
 * bridges them).
 *
 *   pyric snapshot [--out DIR] [--port N] [--force] [--json]
 *
 * Source preference:
 *   1. Live state from a running `pyric sandbox --persist`
 *      (`GET /__pyric/state` — `--port`, else the 3473+ scan window),
 *   2. else hosted SQLite when present, otherwise the browser/MCP JSON store,
 *   3. else exit 2 with a clear message.
 *
 * The output is a directory: `state.json`, a `PyricStateFile` whose Storage
 * entries refer to objects by SHA-256, and `objects/<ab>/<sha256>` holding their
 * bytes. It is directly re-servable: `pyric sandbox --seed <out>`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { hashFile } from '../serve/hosted/persistence/blob-store.js';
import { hostedStateDirectory, loadHostedSnapshot } from '../serve/hosted/persistence.js';
import { isStorageReference, objectFileIn, type StorageObjectReference, type StorageStateEntry } from '../serve/state-file.js';
import { firestoreDocCount } from '../serve/state-summary.js';
import type { ParsedArgs } from './parse-args.js';
import { createStateStore, type PyricStateFile } from '../serve/state-store.js';

/** Ports probed when --port is absent — serve's default + scan window. */
const SCAN_PORTS = [3473, 3474, 3475, 3476, 3477];

/** Replacement for redacted passwords in a promoted fixture. Mirrors pyric's
 *  own `NO_PASSWORD_SENTINEL` so `seedUsers` accepts it on re-serve; defined
 *  locally to avoid depending on a pyric internal export. */
const REDACTED_PASSWORD = '__pyric_no_password__';

/** The bytes of one referenced object: in memory, streamed, or a local file. */
type ObjectBytes = Uint8Array | AsyncIterable<Uint8Array> | { file: string };

interface LiveState {
  envelope: PyricStateFile;
  /** The project dir the live serve reported (pre-mortem #4 guard). */
  projectDir: string | null;
  /** The bytes the document names by `sha256`, from the same host. */
  readObject(sha256: string): Promise<ObjectBytes>;
}

/** An object whose bytes could not be written as the document names them. */
class SnapshotObjectError extends Error {}

async function fetchLive(port: number): Promise<LiveState | null> {
  try {
    let headers: Record<string, string> | undefined;
    try {
      const initRes = await fetch(`http://localhost:${port}/__pyric/init.json`, {
        signal: AbortSignal.timeout(750),
      });
      if (initRes.status === 200) {
        const initData = (await initRes.json()) as { sessionToken?: string };
        if (initData.sessionToken) {
          headers = { 'x-pyric-session-token': initData.sessionToken };
        }
      }
    } catch {
      // If init.json probe fails, attempt state fetch directly
    }
    const requestHeaders: HeadersInit = headers ?? {};
    const res = await fetch(`http://localhost:${port}/__pyric/state`, {
      headers: requestHeaders,
      signal: AbortSignal.timeout(750),
    });
    if (res.status !== 200) return null;
    const body = (await res.json()) as PyricStateFile;
    if (!body || typeof body !== 'object' || !('version' in body)) return null;
    const readObject = async (sha256: string): Promise<ObjectBytes> => {
      const object = await fetch(`http://localhost:${port}/__pyric/state/objects/${sha256}`, { headers: requestHeaders });
      const served = object.status === 200 && object.body !== null;
      if (!served) throw new SnapshotObjectError(`The host on port ${port} did not serve object ${sha256} (HTTP ${object.status}).`);
      // Node's fetch body is a web stream, which is async-iterable in Node.
      return object.body as unknown as AsyncIterable<Uint8Array>;
    };
    return { envelope: body, projectDir: res.headers.get('x-pyric-project-dir'), readObject };
  } catch {
    return null; // No Pyric sandbox is listening. Fall through.
  }
}

export interface SnapshotDeps {
  cwd?: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
  /** Injectable live-fetch (tests). */
  fetchLive?: typeof fetchLive;
}

export async function runSnapshot(parsed: ParsedArgs, deps: SnapshotDeps = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const live = deps.fetchLive ?? fetchLive;
  const json = parsed.flags.get('json') === true || parsed.flags.get('json') === 'true';
  const force = Boolean(parsed.flags.get('force'));
  const report = json ? err : out;

  const outFlag = parsed.flags.get('out');
  const hasOutputPath = typeof outFlag === 'string';
  const outputName = hasOutputPath ? outFlag : 'pyric-state';
  const outPath = resolve(cwd, outputName);
  const refusesOverwrite = existsSync(outPath) && !force;
  if (refusesOverwrite) {
    err.write(`pyric snapshot: ${outPath} already exists — pass --force to overwrite.\n`);
    return 2;
  }

  const portFlag = parsed.flags.get('port');
  const explicitPort = typeof portFlag === 'string';
  let ports = SCAN_PORTS;
  if (explicitPort) ports = [Number(portFlag)];
  const invalidPort = ports.some(p => !Number.isFinite(p) || p < 1 || p > 65535);
  if (invalidPort) {
    err.write(`pyric: invalid --port '${portFlag}'.\n`);
    return 1;
  }

  let envelope: PyricStateFile | null = null;
  let source = '';
  let readObject = (sha256: string): Promise<ObjectBytes> => Promise.reject(new SnapshotObjectError(`No source holds object ${sha256}.`));
  for (const port of ports) {
    const found = await live(port);
    const absent = found === null;
    if (absent) continue;
    // Wrong-project guard (pre-mortem #4): the port scan can hit a NEIGHBOR
    // project's serve (yours down, theirs on 3473). Refuse unless --port was
    // explicit AND warn either way.
    const wrongProject = found.projectDir !== null && found.projectDir !== cwd;
    if (wrongProject) {
      const explicit = typeof portFlag === 'string';
      err.write(
        `pyric snapshot: the dev server on port ${port} persists a DIFFERENT project\n` +
          `  it serves:  ${found.projectDir}\n  you are in: ${cwd}\n`,
      );
      const skipsNeighbor = !explicit;
      if (skipsNeighbor) {
        err.write('  Skipping it (pass --port to promote it anyway).\n');
        continue;
      }
      err.write('  --port was explicit — promoting it as asked.\n');
    }
    envelope = found.envelope;
    readObject = found.readObject;
    source = `live serve on port ${port}`;
    break;
  }
  const hostedPath = join(hostedStateDirectory(cwd), 'state.sqlite');
  const hasOfflineHostedState = envelope === null && existsSync(hostedPath);
  if (hasOfflineHostedState) {
    envelope = await loadHostedSnapshot(cwd);
    readObject = async sha256 => ({ file: objectFileIn(hostedStateDirectory(cwd), sha256) });
    source = hostedPath;
  }
  const useBrowserStore = envelope === null && !hasOfflineHostedState;
  if (useBrowserStore) {
    const store = createStateStore(cwd);
    envelope = store.load(); // throws loudly on corrupt — that's the right surface
    const foundState = envelope !== null;
    if (foundState) source = store.path;
  }
  const selectedState = envelope;
  const missingState = selectedState === null;
  if (missingState) {
    err.write(
      'pyric snapshot: no state found. No `pyric sandbox --persist` is running here and ' +
        'no persisted state exists. Run hosted mode or use --persist in browser mode first.\n',
    );
    return 2;
  }

  let promoted = selectedState;

  // Password hygiene (pre-mortem #4): the promoted fixture is meant to be
  // COMMITTED, and only `.pyric/` is gitignored. Redact user passwords by
  // default — the sentinel round-trips through `seedUsers`, so re-serving
  // still works (popup/helper sign-in doesn't use passwords; email/password
  // sign-in with the original secret won't, which is the point). Opt out
  // with --include-passwords.
  const includePasswords = Boolean(parsed.flags.get('include-passwords'));
  let redactedCount = 0;
  const auth = promoted.auth;
  const redactsAuth = !includePasswords && auth !== null;
  if (redactsAuth) {
    promoted = {
      ...promoted,
      auth: {
        users: auth.users.map((u) => {
          const hasSecret = typeof u.password === 'string' && u.password !== REDACTED_PASSWORD;
          if (hasSecret) {
            redactedCount++;
            return { ...u, password: REDACTED_PASSWORD };
          }
          return u;
        }),
      },
    };
  }

  const redactsController = !includePasswords;
  if (redactsController) promoted.firestore = redactControllerPasswords(promoted.firestore);

  // Strip `savedAt` (pre-mortem: it churns every flush, so committed
  // fixtures would re-diff on every re-promote). Restore ignores it.
  const fsSection = promoted.firestore as { savedAt?: number } | null;
  const hasTimestamp = fsSection !== null && typeof fsSection === 'object' && 'savedAt' in fsSection;
  if (hasTimestamp) {
    const { savedAt: _dropped, ...rest } = fsSection;
    promoted = { ...promoted, firestore: rest };
  }

  const outputIsFile = existsSync(outPath) && !statSync(outPath).isDirectory();
  if (outputIsFile) {
    err.write(`pyric snapshot: ${outPath} is a file; a snapshot is a directory holding state.json and objects/.\n`);
    return 2;
  }
  const createsOutput = !existsSync(outPath);
  mkdirSync(outPath, { recursive: true });
  let objects = 0;
  try {
    const storage = promoted.storage;
    const hasStorage = storage !== undefined;
    if (hasStorage) {
      const references = await writeObjects(storage, outPath, readObject);
      objects = new Set(references.map(reference => reference.sha256)).size;
      promoted = { ...promoted, storage: references };
    }
  } catch (error) {
    const unwritableObject = error instanceof SnapshotObjectError;
    if (!unwritableObject) throw error;
    if (createsOutput) rmSync(outPath, { recursive: true, force: true });
    err.write(`pyric snapshot: ${error.message}\n`);
    return 2;
  }
  // The document is written last, so a directory with state.json is complete.
  const document = join(outPath, 'state.json');
  const partialDocument = `${document}.${randomUUID()}.tmp`;
  writeFileSync(partialDocument, JSON.stringify(promoted, null, 2) + '\n', 'utf8');
  renameSync(partialDocument, document);

  const docs = firestoreDocCount(promoted.firestore);
  const users = promoted.auth?.users?.length ?? 0;
  report.write(`pyric snapshot: ${docs} doc(s) + ${users} user(s) + ${objects} object file(s) from ${source}\n`);
  report.write(`  → ${outPath}\n`);
  const redactedPasswords = redactedCount > 0;
  if (redactedPasswords) {
    report.write(`  ⓘ redacted ${redactedCount} password(s) — re-run with --include-passwords to keep them\n`);
  }
  report.write(`  Re-serve it: pyric sandbox --seed ${outputName}\n`);
  if (json) out.write(JSON.stringify({ out: outPath, docs, users, objects, source, redactedPasswords: redactedCount }) + '\n');
  return 0;
}

/**
 * Write every object's bytes to `objects/<ab>/<sha256>` in the snapshot
 * directory and return the document's Storage as references. Inline bytes are
 * written out; referenced bytes are read from their source and checked
 * against their hash.
 */
async function writeObjects(
  entries: readonly StorageStateEntry[],
  directory: string,
  readObject: (sha256: string) => Promise<ObjectBytes>,
): Promise<StorageObjectReference[]> {
  const written = new Set<string>();
  const references: StorageObjectReference[] = [];
  for (const entry of entries) {
    const referenced = isStorageReference(entry);
    const reference: StorageObjectReference = referenced ? entry : {
      path: entry.metadata.fullPath,
      sha256: createHash('sha256').update(Buffer.from(entry.dataBase64, 'base64')).digest('hex'),
      size: entry.metadata.size,
      blobType: entry.blobType,
      metadata: entry.metadata,
    };
    references.push(reference);
    const alreadyWritten = written.has(reference.sha256);
    if (alreadyWritten) continue;
    const bytes: ObjectBytes = referenced ? await readObject(entry.sha256) : Buffer.from(entry.dataBase64, 'base64');
    await writeObject(reference, directory, bytes);
    written.add(reference.sha256);
  }
  return references;
}

async function writeObject(reference: StorageObjectReference, directory: string, bytes: ObjectBytes): Promise<void> {
  const target = objectFileIn(directory, reference.sha256);
  mkdirSync(dirname(target), { recursive: true });
  const partial = `${target}.${randomUUID()}.tmp`;
  try {
    const isFile = 'file' in bytes;
    const isBuffer = bytes instanceof Uint8Array;
    if (isFile) copyFileSync(bytes.file, partial);
    else if (isBuffer) writeFileSync(partial, bytes);
    else await pipeline(Readable.from(bytes), createWriteStream(partial));
    const intact = statSync(partial).size === reference.size && hashFile(partial) === reference.sha256;
    const mismatched = !intact;
    if (mismatched) throw new SnapshotObjectError(`Storage object '${reference.path}' did not arrive as the bytes its hash ${reference.sha256} names.`);
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { force: true });
    const missingFile = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    if (missingFile) throw new SnapshotObjectError(`Storage object '${reference.path}' has no file for hash ${reference.sha256}.`);
    throw error;
  }
}

/** Auth also lives inside controller exports; redact only those known paths. */
function redactControllerPasswords(value: unknown): unknown {
  const controller = structuredClone(value);
  const hasController = isRecord(controller);
  const missingController = !hasController;
  if (missingController) return controller;
  const records = controller.records;
  const hasRecords = isRecord(records);
  const metadata = hasRecords ? records.meta : controller;
  const hasMetadata = isRecord(metadata);
  const missingMetadata = !hasMetadata;
  if (missingMetadata) return controller;
  const services = metadata.services;
  const hasServices = isRecord(services);
  const missingServices = !hasServices;
  if (missingServices) return controller;
  const auth = services.auth;
  const hasAuth = isRecord(auth);
  const missingAuth = !hasAuth;
  if (missingAuth) return controller;
  const users = auth.users;
  const hasUsers = Array.isArray(users);
  const missingUsers = !hasUsers;
  if (missingUsers) return controller;
  for (const user of users) {
    const hasUser = isRecord(user);
    const missingUser = !hasUser;
    if (missingUser) continue;
    const hasPassword = typeof user.password === 'string';
    if (hasPassword) user.password = REDACTED_PASSWORD;
  }
  return controller;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
