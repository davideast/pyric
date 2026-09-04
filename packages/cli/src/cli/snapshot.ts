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
 *   2. else the on-disk `.pyric/state/state.json`,
 *   3. else exit 2 with a clear message.
 *
 * The output is a `PyricStateFile` envelope — directly re-servable:
 * `pyric sandbox --seed <out>` (the state-file shape is detected by its
 * `version` key and seeds docs + users).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

async function fetchLive(port: number): Promise<LiveState | null> {
  try {
    const res = await fetch(`http://localhost:${port}/__pyric/state`, {
      signal: AbortSignal.timeout(750),
    });
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
  const outPath = resolve(cwd, typeof outFlag === 'string' ? outFlag : 'pyric-state.json');
  if (existsSync(outPath) && !force) {
    err.write(`pyric snapshot: ${outPath} already exists — pass --force to overwrite.\n`);
    return 2;
  }

  const portFlag = parsed.flags.get('port');
  const ports = typeof portFlag === 'string' ? [Number(portFlag)] : SCAN_PORTS;
  if (ports.some((p) => !Number.isFinite(p) || p < 1 || p > 65535)) {
    err.write(`pyric: invalid --port '${portFlag}'.\n`);
    return 1;
  }

  let envelope: PyricStateFile | null = null;
  let source = '';
  for (const port of ports) {
    const found = await live(port);
    if (!found) continue;
    // Wrong-project guard (pre-mortem #4): the port scan can hit a NEIGHBOR
    // project's serve (yours down, theirs on 3473). Refuse unless --port was
    // explicit AND warn either way.
    if (found.projectDir && found.projectDir !== cwd) {
      const explicit = typeof portFlag === 'string';
      err.write(
        `pyric snapshot: the dev server on port ${port} persists a DIFFERENT project\n` +
          `  it serves:  ${found.projectDir}\n  you are in: ${cwd}\n`,
      );
      if (!explicit) {
        err.write('  Skipping it (pass --port to promote it anyway).\n');
        continue;
      }
      err.write('  --port was explicit — promoting it as asked.\n');
    }
    envelope = found.envelope;
    source = `live serve on port ${port}`;
    break;
  }
  if (!envelope) {
    const store = createStateStore(cwd);
    envelope = store.load(); // throws loudly on corrupt — that's the right surface
    if (envelope) source = store.path;
  }
  if (!envelope) {
    err.write(
      'pyric snapshot: no state found. No `pyric sandbox --persist` is running here and ' +
        'no .pyric/state/state.json exists. Run with --persist (and use the app) first.\n',
    );
    return 2;
  }

  // Password hygiene (pre-mortem #4): the promoted fixture is meant to be
  // COMMITTED, and only `.pyric/` is gitignored. Redact user passwords by
  // default — the sentinel round-trips through `seedUsers`, so re-serving
  // still works (popup/helper sign-in doesn't use passwords; email/password
  // sign-in with the original secret won't, which is the point). Opt out
  // with --include-passwords.
  const includePasswords = Boolean(parsed.flags.get('include-passwords'));
  let redactedCount = 0;
  if (!includePasswords && envelope.auth?.users) {
    envelope = {
      ...envelope,
      auth: {
        users: envelope.auth.users.map((u) => {
          if (typeof u.password === 'string' && u.password !== REDACTED_PASSWORD) {
            redactedCount++;
            return { ...u, password: REDACTED_PASSWORD };
          }
          return u;
        }),
      },
    };
  }

  // Strip `savedAt` (pre-mortem: it churns every flush, so committed
  // fixtures would re-diff on every re-promote). Restore ignores it.
  const fsSection = envelope.firestore as { savedAt?: number } | null;
  if (fsSection && typeof fsSection === 'object' && 'savedAt' in fsSection) {
    const { savedAt: _dropped, ...rest } = fsSection;
    envelope = { ...envelope, firestore: rest };
  }

  writeFileSync(outPath, JSON.stringify(envelope, null, 2) + '\n', 'utf8');

  const docs = Object.keys(
    ((envelope.firestore as { firestore?: Record<string, unknown> } | null)?.firestore) ?? {},
  ).length;
  const users = envelope.auth?.users?.length ?? 0;
  report.write(`pyric snapshot: ${docs} doc(s) + ${users} user(s) from ${source}\n`);
  report.write(`  → ${outPath}\n`);
  if (redactedCount > 0) {
    report.write(`  ⓘ redacted ${redactedCount} password(s) — re-run with --include-passwords to keep them\n`);
  }
  report.write(`  Re-serve it: pyric sandbox --seed ${typeof outFlag === 'string' ? outFlag : 'pyric-state.json'}\n`);
  if (json) out.write(JSON.stringify({ out: outPath, docs, users, source, redactedPasswords: redactedCount }) + '\n');
  return 0;
}
