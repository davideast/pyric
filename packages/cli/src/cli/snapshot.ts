/**
 * `pyric snapshot` — promote lived sandbox state to a committable fixture
 * (flow doc section 3c: seed.json is intent, `.pyric/state/` is runtime, promote
 * bridges them).
 *
 *   pyric snapshot [--out FILE] [--port N] [--force] [--json]
 *
 * Source preference:
 *   1. Live state from a running `pyric sandbox --persist`
 *      (`GET /__pyric/state` — `--port`, else the 3473+ scan window),
 *   2. else hosted SQLite when present, otherwise the browser/MCP JSON store,
 *   3. else exit 2 with a clear message.
 *
 * The output is a `PyricStateFile` envelope — directly re-servable:
 * `pyric sandbox --seed <out>` (the state-file shape is detected by its
 * `version` key and seeds docs + users).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostedStateDirectory, loadHostedSnapshot } from '../serve/hosted/persistence.js';
import { StateExportTooLargeError } from '../serve/hosted/persistence/export-limit.js';
import { firestoreDocCount } from '../serve/state-summary.js';
import type { ParsedArgs } from './parse-args.js';
import { createStateStore, type PyricStateFile } from '../serve/state-store.js';

/** Ports probed when --port is absent — serve's default + scan window. */
const SCAN_PORTS = [3473, 3474, 3475, 3476, 3477];

/** Replacement for redacted passwords in a promoted fixture. Mirrors pyric's
 *  own `NO_PASSWORD_SENTINEL` so `seedUsers` accepts it on re-serve; defined
 *  locally to avoid depending on a pyric internal export. */
const REDACTED_PASSWORD = '__pyric_no_password__';

interface LiveState {
  envelope: PyricStateFile;
  /** The project dir the live serve reported (pre-mortem #4 guard). */
  projectDir: string | null;
}

/** A live host that answered and refused the export, with its reason. */
interface RefusedExport {
  refused: string;
}

async function fetchLive(port: number): Promise<LiveState | RefusedExport | null> {
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
    const exportRefused = res.status === 413;
    if (exportRefused) return { refused: await res.text() };
    if (res.status !== 200) return null;
    const body = (await res.json()) as PyricStateFile;
    if (!body || typeof body !== 'object' || !('version' in body)) return null;
    return { envelope: body, projectDir: res.headers.get('x-pyric-project-dir') };
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
  const outputName = hasOutputPath ? outFlag : 'pyric-state.json';
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
  for (const port of ports) {
    const found = await live(port);
    const absent = found === null;
    if (absent) continue;
    const refused = 'refused' in found;
    if (refused) {
      err.write(`pyric snapshot: ${found.refused}\n`);
      return 2;
    }
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
    source = `live serve on port ${port}`;
    break;
  }
  const hostedPath = join(hostedStateDirectory(cwd), 'state.sqlite');
  const hasOfflineHostedState = envelope === null && existsSync(hostedPath);
  if (hasOfflineHostedState) {
    try {
      envelope = await loadHostedSnapshot(cwd);
    } catch (error) {
      const exportTooLarge = error instanceof StateExportTooLargeError;
      if (!exportTooLarge) throw error;
      err.write(`pyric snapshot: ${error.message}\n`);
      return 2;
    }
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

  writeFileSync(outPath, JSON.stringify(promoted, null, 2) + '\n', 'utf8');

  const docs = firestoreDocCount(promoted.firestore);
  const users = promoted.auth?.users?.length ?? 0;
  report.write(`pyric snapshot: ${docs} doc(s) + ${users} user(s) from ${source}\n`);
  report.write(`  → ${outPath}\n`);
  const redactedPasswords = redactedCount > 0;
  if (redactedPasswords) {
    report.write(`  ⓘ redacted ${redactedCount} password(s) — re-run with --include-passwords to keep them\n`);
  }
  report.write(`  Re-serve it: pyric sandbox --seed ${outputName}\n`);
  if (json) out.write(JSON.stringify({ out: outPath, docs, users, source, redactedPasswords: redactedCount }) + '\n');
  return 0;
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
