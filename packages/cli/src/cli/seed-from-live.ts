/**
 * `pyric sandbox seed-from-live` — explicit opt-in seeding or export of
 * session-observed Live mode data into a local sandbox.
 *
 *   pyric sandbox seed-from-live --confirm [--replace] [--json]
 *   pyric sandbox seed-from-live --out <FILE> [--instance <NAME>] [--force] [--json]
 *
 * Live mode (`@pyric/live`) never mirrors observed production documents or RTDB
 * values onto disk automatically. This command lets a developer explicitly
 * materialize the running live host's in-memory observed session data into
 * `.pyric/state/hosted` (requiring `--confirm`) or export it as a `SandboxSeed`
 * JSON file (`--out <FILE>`) for `pyric sandbox --seed <FILE>`.
 *
 * A seed file holds one RTDB tree, so `--out` exports the default instance or
 * the one `--instance` names, and names every other observed instance it left
 * out; `--confirm` seeds every instance.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { ParsedArgs } from './parse-args.js';
import { discoverServe, type Discovered } from '../serve/discovery.js';
import { resolveSessionTokenForTarget } from '../serve/local-session-token.js';
import { ensureGitignored } from '../serve/capture-store.js';
import { isPathInside } from '../serve/path-inside.js';
import {
  LIVE_SEED_SANDBOX_PATH,
  LIVE_SESSION_DATA_PATH,
  type LiveSeedMode,
  type LiveSeedSandboxResult,
  type ObservedSessionDataSnapshot,
} from '../serve/observed-session/wire.js';

interface Output {
  write(value: string): void;
}

export interface SeedFromLiveDeps {
  cwd?: string;
  stdout?: Output;
  stderr?: Output;
  discover?: (cwd: string) => Promise<Discovered | null>;
  fetchImpl?: typeof fetch;
}

/** The seed file `--out` writes, as `pyric sandbox --seed` reads it. */
interface SeedFile {
  firestore: Record<string, Record<string, unknown>>;
  database?: Record<string, unknown>;
}

const PREFIX = 'pyric sandbox seed-from-live:';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function isEscapedSessionMap(value: Record<string, unknown>): value is { type: 'pyric/map/1.0'; fields: Record<string, unknown> } {
  const keys = Object.keys(value);
  return keys.length === 2 && Object.hasOwn(value, 'type') && value.type === 'pyric/map/1.0' && isPlainRecord(value.fields);
}

function needsSeedMapEscape(record: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(record, 'type') ||
    Object.hasOwn(record, '__type') ||
    Object.hasOwn(record, '__type__') ||
    Object.hasOwn(record, '__proto__')
  );
}

function sessionValueToSeedValue(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) return value.map((item) => sessionValueToSeedValue(item, depth + 1));
  if (!isPlainRecord(value)) return value;

  if (isEscapedSessionMap(value)) {
    const converted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value.fields)) {
      setOwn(converted, key, sessionValueToSeedValue(item, depth + 1));
    }
    if (depth === 0) {
      return isEscapedSessionMap(converted) ? { type: 'pyric/map/1.0', fields: converted } : converted;
    }
    return needsSeedMapEscape(converted) ? { type: 'pyric/map/1.0', fields: converted } : converted;
  }

  const keys = Object.keys(value);
  if (depth > 0) {
    if (
      keys.length === 2 &&
      typeof value.seconds === 'number' &&
      Number.isFinite(value.seconds) &&
      typeof value.nanoseconds === 'number' &&
      Number.isFinite(value.nanoseconds)
    ) {
      return {
        type: 'firestore/timestamp/1.0',
        seconds: Math.trunc(value.seconds),
        nanoseconds: Math.trunc(value.nanoseconds),
      };
    }
    if (
      keys.length === 2 &&
      typeof value.latitude === 'number' &&
      Number.isFinite(value.latitude) &&
      typeof value.longitude === 'number' &&
      Number.isFinite(value.longitude)
    ) {
      return {
        type: 'firestore/geoPoint/1.0',
        latitude: value.latitude,
        longitude: value.longitude,
      };
    }
    if (keys.length === 2 && value.type === 'firestore/bytes/1.0' && typeof value.bytes === 'string') {
      return { type: 'firestore/bytes/1.0', bytes: value.bytes };
    }
    if (
      keys.length === 2 &&
      value.__type__ === '__vector__' &&
      Array.isArray(value.value) &&
      value.value.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      return { type: 'firestore/vectorValue/1.0', vectorValues: [...value.value] };
    }
    if (
      keys.length === 3 &&
      value.type === 'document' &&
      typeof value.path === 'string' &&
      value.path.length > 0 &&
      typeof value.id === 'string'
    ) {
      return {
        __type: 'reference',
        path: value.path.startsWith('/') ? value.path.slice(1) : value.path,
      };
    }
  }

  const converted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    setOwn(converted, key, sessionValueToSeedValue(item, depth + 1));
  }
  if (depth > 0 && needsSeedMapEscape(converted)) {
    return { type: 'pyric/map/1.0', fields: converted };
  }
  if (depth === 0 && isEscapedSessionMap(converted)) {
    return { type: 'pyric/map/1.0', fields: converted };
  }
  return converted;
}

function sessionFirestoreToSeedDocs(
  docs: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [docPath, rawDoc] of Object.entries(docs)) {
    setOwn(out, docPath, sessionValueToSeedValue(rawDoc, 0) as Record<string, unknown>);
  }
  return out;
}

function isUnderPyricDir(projectDir: string, targetPath: string): boolean {
  if (!isPathInside(projectDir, targetPath)) return false;
  const rel = relative(projectDir, targetPath);
  return rel === '.pyric' || rel.startsWith(`.pyric${sep}`);
}

function isTrueFlag(value: unknown): boolean {
  return value === true || value === 'true';
}

/** Whether a flag was left out or given as a boolean (`--flag`, `--flag true`, `--flag false`). */
function isBooleanFlag(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean' || value === 'true' || value === 'false';
}

/** The host's answer as a JSON body, or the exit code after naming why there is none. */
async function requestHost(
  fetchFn: typeof fetch,
  url: URL,
  init: RequestInit,
  host: Discovered,
  err: Output,
  cwd?: string,
): Promise<unknown | number> {
  const token = resolveSessionTokenForTarget({
    explicitToken: host.token,
    url: host.base,
    cwd: host.pointerProjectDir ?? cwd,
  });
  const headers = new Headers(init.headers);
  if (token !== undefined && !headers.has('x-pyric-session-token')) {
    headers.set('x-pyric-session-token', token);
  }
  let response: Response;
  try {
    response = await fetchFn(url, {
      ...init,
      ...(Array.from(headers.keys()).length > 0 ? { headers: Object.fromEntries(headers.entries()) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    err.write(`${PREFIX} the host at ${host.base} did not answer: ${reason}\n`);
    return 2;
  }
  if (response.status === 404) {
    err.write(`${PREFIX} the running server is not in Live mode (\`@pyric/live\`).\n`);
    return 2;
  }
  const bodyText = await response.text();
  if (response.ok) return JSON.parse(bodyText) as unknown;
  let reason = bodyText;
  try {
    reason = (JSON.parse(bodyText) as { error?: string }).error ?? bodyText;
  } catch {
    // Leave plain text as-is.
  }
  err.write(`${PREFIX} ${reason}\n`);
  return 1;
}

/** The seed file for one RTDB instance of the snapshot, with the instance it holds or null. */
function seedFileOf(snapshot: ObservedSessionDataSnapshot, chosenInstance: string | null): { seed: SeedFile; instance: string | null } {
  const seed: SeedFile = { firestore: sessionFirestoreToSeedDocs(snapshot.firestore) };
  if (chosenInstance === null) return { seed, instance: null };
  const tree = snapshot.rtdb[chosenInstance];
  if (!isPlainRecord(tree)) return { seed, instance: null };
  seed.database = tree;
  return { seed, instance: chosenInstance };
}

/** Warnings for what `--out` leaves out or may expose: other observed instances, and a file git may commit. */
function exportWarnings(snapshot: ObservedSessionDataSnapshot, exported: string | null, cwd: string, targetPath: string): string[] {
  const warnings: string[] = [];
  const leftOut = Object.keys(snapshot.rtdb).filter((name) => name !== exported);
  if (leftOut.length > 0) {
    warnings.push(
      `${PREFIX} a seed file holds one RTDB instance; not exported: ${leftOut.join(', ')}. ` +
        'Pass --instance <name> to export another one, or --confirm to seed every instance into .pyric/state/hosted.',
    );
  }
  const isUnignoredProjectFile = isPathInside(cwd, targetPath) && !isUnderPyricDir(cwd, targetPath);
  if (isUnignoredProjectFile) {
    warnings.push(
      `${PREFIX} ${targetPath} holds observed production data inside the project. Add it to .gitignore, or export under .pyric/.`,
    );
  }
  return warnings;
}

async function exportSeedFile(
  parsed: ParsedArgs,
  outFlag: string,
  host: Discovered,
  io: { cwd: string; out: Output; err: Output; fetchFn: typeof fetch; jsonOutput: boolean },
): Promise<number> {
  const { cwd, out, err, fetchFn, jsonOutput } = io;
  const targetPath = resolve(cwd, outFlag);
  if (existsSync(targetPath) && !isTrueFlag(parsed.flags.get('force'))) {
    err.write(`${PREFIX} ${targetPath} already exists. Pass --force to overwrite it.\n`);
    return 2;
  }
  const answered = await requestHost(fetchFn, new URL(LIVE_SESSION_DATA_PATH, host.base), { method: 'GET' }, host, err, cwd);
  if (typeof answered === 'number') return answered;
  const snapshot = answered as ObservedSessionDataSnapshot;
  const instanceFlag = parsed.flags.get('instance');
  let chosenInstance = snapshot.defaultRtdbInstance;
  if (typeof instanceFlag === 'string') chosenInstance = instanceFlag;
  const { seed, instance } = seedFileOf(snapshot, chosenInstance);

  if (isUnderPyricDir(cwd, targetPath)) ensureGitignored(cwd);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(seed, null, 2)}\n`);

  const warnings = exportWarnings(snapshot, instance, cwd, targetPath);
  for (const warning of warnings) err.write(`${warning}\n`);
  const firestoreDocs = Object.keys(seed.firestore).length;
  if (jsonOutput) {
    const notExported = Object.keys(snapshot.rtdb).filter((name) => name !== instance);
    out.write(`${JSON.stringify({ ok: true, out: targetPath, firestoreDocs, rtdbInstance: instance, notExported, revision: snapshot.revision })}\n`);
    return 0;
  }
  let rtdbSummary = '';
  if (instance !== null) rtdbSummary = ` and RTDB instance '${instance}'`;
  out.write(
    `Exported ${firestoreDocs} observed Firestore document(s)${rtdbSummary} to ${targetPath}.\n` +
      `Start a local sandbox with it using: pyric sandbox --seed ${outFlag}\n`,
  );
  return 0;
}

async function seedHostedSandbox(
  mode: LiveSeedMode,
  host: Discovered & { instanceId: string },
  io: { cwd: string; out: Output; err: Output; fetchFn: typeof fetch; jsonOutput: boolean },
): Promise<number> {
  const { cwd, out, err, fetchFn, jsonOutput } = io;
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = resolve(cwd);
  }
  const answered = await requestHost(
    fetchFn,
    new URL(LIVE_SEED_SANDBOX_PATH, host.base),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true, mode, instanceId: host.instanceId, projectDir: realCwd }),
    },
    host,
    err,
    cwd,
  );
  if (typeof answered === 'number') return answered;
  const result = answered as LiveSeedSandboxResult;
  if (jsonOutput) {
    out.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const instances = result.seededRtdbInstances;
  let rtdbSummary = '';
  if (instances.length > 0) rtdbSummary = ` and ${instances.length} RTDB instance(s) (${instances.join(', ')})`;
  out.write(
    `Seeded local sandbox (.pyric/state/hosted, mode=${result.mode}) with ${result.seededFirestoreDocs} observed Firestore document(s)${rtdbSummary}.\n` +
      'Live mode remains read-only; switch to `pyric sandbox` or `pyric()` to browse and edit the seeded local sandbox.\n',
  );
  return 0;
}

export async function runSeedFromLive(
  parsed: ParsedArgs,
  deps: SeedFromLiveDeps = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const io = {
    cwd,
    out: deps.stdout ?? process.stdout,
    err: deps.stderr ?? process.stderr,
    fetchFn: deps.fetchImpl ?? fetch,
    jsonOutput: Boolean(parsed.flags.get('json')),
  };
  const { err } = io;

  const outFlag = parsed.flags.get('out');
  const rawConfirm = parsed.flags.get('confirm');
  if (!isBooleanFlag(rawConfirm)) {
    err.write(`${PREFIX} --confirm must be boolean (pass --confirm alone).\n`);
    return 1;
  }
  const confirm = isTrueFlag(rawConfirm);

  if (outFlag === true) {
    err.write(`${PREFIX} --out requires a file path.\n`);
    return 1;
  }

  if (parsed.flags.has('mode')) {
    err.write(`${PREFIX} --mode is not a flag. Seeding merges by default; pass --replace to replace the local sandbox instead.\n`);
    return 1;
  }
  const rawReplace = parsed.flags.get('replace');
  if (!isBooleanFlag(rawReplace)) {
    err.write(`${PREFIX} --replace must be boolean (pass --replace alone).\n`);
    return 1;
  }
  let mode: LiveSeedMode = 'merge';
  if (isTrueFlag(rawReplace)) mode = 'replace';

  const exportsFile = typeof outFlag === 'string';
  if (!exportsFile && !confirm) {
    err.write(
      `${PREFIX} seeding observed production data into the local sandbox writes to .pyric/state/hosted on disk and requires explicit confirmation.\n` +
        'Pass --confirm [--replace] to seed .pyric/state/hosted, or --out <file.json> to export a seed JSON file.\n',
    );
    return 1;
  }

  const host = await (deps.discover ?? discoverServe)(cwd);
  if (host === null || host.instanceId === null) {
    err.write(
      `${PREFIX} no running Live mode host found for this project. Keep your \`@pyric/live\` server running while invoking this command.\n`,
    );
    return 2;
  }

  if (exportsFile) return exportSeedFile(parsed, outFlag, host, io);
  return seedHostedSandbox(mode, { ...host, instanceId: host.instanceId }, io);
}
