#!/usr/bin/env bun
/**
 * Client app-registry oracle runner.
 *
 * The client analog of `src/admin-app-probes.ts`: that one probes
 * firebase-admin's in-process AppStore, this one probes the INSTALLED
 * `firebase/app` (client) package's app registry. Each probe lives in its own
 * file in `probes/app/`, named EXACTLY like the observation it produces minus
 * the `.json` extension — the filename IS the probe's identity; there is no
 * separate `name` field on either side to drift out of sync.
 *
 * Probes are pure in-process calls against the installed firebase/app package:
 * initializeApp default/named/duplicate semantics, getApp/getApps/deleteApp,
 * the FirebaseError shapes for app/no-app / app/duplicate-app / app/app-deleted,
 * SDK_VERSION, the FirebaseError class, and the observable
 * onLog/setLogLevel/registerVersion logging seam. No credentials, no project,
 * no network — see `../rigs/app-registry.ts` for the rig manifest.
 *
 * Two modes:
 *   verify (default) — runs every probe in memory, deep-compares its result
 *     against the committed observation's `behavior`, prints a per-probe
 *     match/mismatch table plus the installed firebase version against each
 *     observation's pinned `fbSdkVersion`. Writes NOTHING. Exits 1 on any
 *     behavior mismatch, missing observation, or probe error; 0 otherwise.
 *   --write — overwrites the observation files with a fresh capture (same
 *     envelope fields as the committed files), reusing each probe's
 *     description/matrixRow/rowIds verbatim as probe metadata. Never
 *     fabricates: `behavior` is exactly what `observe()` returned.
 *
 * Usage:
 *   bun run packages/conformance/src/app-registry-probes.ts            # verify
 *   bun run packages/conformance/src/app-registry-probes.ts --write     # recapture
 */
import { deleteApp, getApps } from 'firebase/app';
import { readFileSync, readdirSync } from 'node:fs';
import { writeObservationFile } from './observation-hash.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Probe } from '../rigs/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBES_DIR = join(HERE, '..', 'probes', 'app');
const OBS_DIR = join(HERE, '..', 'observations', 'app');
const PREFIX = 'app-registry-';

interface LoadedProbe {
  id: string;
  probe: Probe;
}

/** Loads every app-registry-* probe file (any non-matching file in the same
 *  directory is skipped by the prefix filter). */
async function loadProbes(): Promise<LoadedProbe[]> {
  const files = readdirSync(PROBES_DIR)
    .filter((file) => file.startsWith(PREFIX) && file.endsWith('.ts'))
    .sort();
  const loaded: LoadedProbe[] = [];
  for (const file of files) {
    const id = file.slice(0, -'.ts'.length);
    const mod = (await import(pathToFileURL(join(PROBES_DIR, file)).href)) as { probe?: Probe };
    if (!mod.probe || typeof mod.probe.observe !== 'function') {
      throw new Error(`probes/app/${file}: does not export a 'probe' record with an observe() method`);
    }
    loaded.push({ id, probe: mod.probe });
  }
  return loaded;
}

/** Resolved (installed) firebase version — what the observation-version guard
 *  (check-observation-versions.ts) compares every app-registry-* observation's
 *  `fbSdkVersion` against. */
function resolvedFirebaseVersion(): string {
  const pkgPath = fileURLToPath(import.meta.resolve('firebase/package.json'));
  const meta = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
  if (!meta.version) throw new Error('could not resolve installed firebase version');
  return meta.version;
}

/** Every probe assumes an empty app registry on entry and must leave one behind
 *  for the next — reset around every probe run regardless of what an individual
 *  probe does internally, so probes stay independent. */
async function resetAppRegistry(): Promise<void> {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural deep equality. Deliberately NOT a JSON.stringify comparison —
 *  stringify is sensitive to object key order, which would falsely fail a match
 *  between two behavior objects with the same keys/values in different order. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, i) => deepEqual(entry, b[i]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((key, i) => key !== bKeys[i])) return false;
    return aKeys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

interface ObservationEnvelope {
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  observedAt: string;
  fbSdkVersion: string;
  behavior: Record<string, unknown>;
}

function observationPath(id: string): string {
  return join(OBS_DIR, `${id}.json`);
}

function loadObservation(id: string): ObservationEnvelope | undefined {
  try {
    return JSON.parse(readFileSync(observationPath(id), 'utf8')) as ObservationEnvelope;
  } catch {
    return undefined;
  }
}

type Outcome = 'match' | 'mismatch' | 'missing-observation' | 'probe-error';

interface Result {
  id: string;
  outcome: Outcome;
  installedVersion: string;
  capturedVersion?: string;
  detail?: string;
}

function diffSummary(actual: Record<string, unknown>, expected: Record<string, unknown>): string {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  const diffs: string[] = [];
  for (const key of keys) {
    if (!deepEqual(actual[key], expected[key])) {
      diffs.push(`${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(actual[key])}`);
    }
  }
  return diffs.join('; ');
}

async function verify(probes: LoadedProbe[], installedVersion: string): Promise<Result[]> {
  const results: Result[] = [];
  for (const { id, probe } of probes) {
    await resetAppRegistry();
    let behavior: Record<string, unknown> | undefined;
    let error: unknown;
    try {
      behavior = await probe.observe();
    } catch (e) {
      error = e;
    }
    await resetAppRegistry();

    if (error) {
      results.push({
        id,
        outcome: 'probe-error',
        installedVersion,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const observation = loadObservation(id);
    if (!observation) {
      results.push({ id, outcome: 'missing-observation', installedVersion });
      continue;
    }

    const matches = deepEqual(behavior, observation.behavior);
    results.push({
      id,
      outcome: matches ? 'match' : 'mismatch',
      installedVersion,
      capturedVersion: observation.fbSdkVersion,
      detail: matches ? undefined : diffSummary(behavior as Record<string, unknown>, observation.behavior),
    });
  }
  return results;
}

async function write(probes: LoadedProbe[], installedVersion: string): Promise<void> {
  for (const { id, probe } of probes) {
    await resetAppRegistry();
    const behavior = await probe.observe();
    await resetAppRegistry();
    const envelope: ObservationEnvelope = {
      name: id,
      matrixRow: probe.matrixRow,
      rowIds: probe.rowIds,
      description: probe.description,
      observedAt: new Date().toISOString(),
      fbSdkVersion: installedVersion,
      behavior,
    };
    writeObservationFile(observationPath(id), envelope);
    console.log(`  wrote ${id}.json`);
  }
}

async function main(): Promise<void> {
  const wantsWrite = process.argv.includes('--write');
  const probes = await loadProbes();
  const installedVersion = resolvedFirebaseVersion();

  if (wantsWrite) {
    console.log(`[app-registry-probes] recapturing ${probes.length} observation(s) against firebase ${installedVersion}\n`);
    await write(probes, installedVersion);
    console.log('\n[app-registry-probes] capture complete.');
    process.exit(0);
  }

  console.log(`[app-registry-probes] verifying ${probes.length} probe(s) against firebase ${installedVersion}\n`);
  const results = await verify(probes, installedVersion);

  const idWidth = Math.max(...results.map((r) => r.id.length));
  for (const result of results) {
    const status = result.outcome === 'match' ? 'MATCH' : result.outcome.toUpperCase();
    const versionNote = result.capturedVersion
      ? result.capturedVersion === result.installedVersion
        ? `fbSdkVersion ${result.capturedVersion} = installed`
        : `fbSdkVersion ${result.capturedVersion} != installed ${result.installedVersion}`
      : `installed ${result.installedVersion} (no captured version — ${result.outcome})`;
    console.log(`  ${result.id.padEnd(idWidth)}  ${status.padEnd(18)} ${versionNote}`);
    if (result.detail) console.log(`    ${result.detail}`);
  }

  const failed = results.filter((r) => r.outcome !== 'match');
  console.log(
    `\n${failed.length === 0 ? '✓' : '✗'} ${results.length - failed.length}/${results.length} probes match their committed observation.`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
