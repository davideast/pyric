#!/usr/bin/env bun
/**
 * Client Storage oracle runner.
 *
 * Runs pure in-process `client-storage-*` probes under `probes/storage/`
 * against the installed `firebase/storage` package. Client-side URL parsing and
 * root-reference preflight checks need no credentials, no project, and no
 * network; see `../rigs/client-storage.ts` for the rig manifest.
 *
 * Two modes:
 *   verify (default) -- runs every captured probe in memory and compares its
 *     result with the committed observation's `behavior` and `fbSdkVersion`.
 *     Writes nothing. Exits 1 on any difference.
 *   --write -- overwrites the selected observation file(s) with a fresh capture.
 *
 * Usage:
 *   bun run packages/conformance/src/client-storage-probes.ts                         # verify
 *   bun run packages/conformance/src/client-storage-probes.ts --write                 # recapture all committed
 *   bun run packages/conformance/src/client-storage-probes.ts --write --probe <name>  # capture one probe
 */
import { deleteApp, getApps } from 'firebase/app';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Probe } from '../rigs/types.ts';
import { readObservationLinkage } from './observation-linkage.ts';
import { resolvedFirebaseVersion } from './package-version.ts';
import { readSingleProbeSelector } from './probe-cli-args.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBES_DIR = join(HERE, '..', 'probes', 'storage');
const OBS_DIR = join(HERE, '..', 'observations', 'storage');
const PREFIX = 'client-storage-';
const DEFAULT_ID = 'client-storage-ref-urls';

interface ObservationEnvelope {
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  observedAt: string;
  fbSdkVersion: string;
  behavior: Record<string, unknown>;
}

export interface LoadedClientStorageProbe {
  id: string;
  probe: Probe;
}

function observationPath(id: string): string {
  return join(OBS_DIR, `${id}.json`);
}

async function resetClientApps(): Promise<void> {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => deepEqual(value, b[index]))
    );
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord).sort();
    const bKeys = Object.keys(bRecord).sort();
    return deepEqual(aKeys, bKeys) && aKeys.every((key) => deepEqual(aRecord[key], bRecord[key]));
  }
  return false;
}

export async function loadClientStorageProbes(): Promise<LoadedClientStorageProbe[]> {
  const files = readdirSync(PROBES_DIR)
    .filter((file) => file.startsWith(PREFIX) && file.endsWith('.ts'))
    .sort();
  const loaded: LoadedClientStorageProbe[] = [];
  for (const file of files) {
    const id = file.slice(0, -'.ts'.length);
    const mod = (await import(pathToFileURL(join(PROBES_DIR, file)).href)) as { probe?: Probe };
    if (!mod.probe || typeof mod.probe.observe !== 'function') {
      throw new Error(
        `probes/storage/${file}: does not export a 'probe' record with an observe() method`,
      );
    }
    loaded.push({ id, probe: mod.probe });
  }
  return loaded;
}

export async function captureClientStorageObservation(
  record: Probe,
  fbSdkVersion: string,
  id: string = DEFAULT_ID,
  existingLinkage: { matrixRow: string; rowIds: string[] } = { matrixRow: '', rowIds: [] },
): Promise<ObservationEnvelope> {
  const matrixRow = record.matrixRow || existingLinkage.matrixRow;
  let rowIds = existingLinkage.rowIds;
  if (record.rowIds.length > 0) {
    rowIds = record.rowIds;
  }
  await resetClientApps();
  try {
    const rawBehavior = await record.observe();
    // A JSON round trip drops fields a probe left undefined, as committed files do.
    const behavior = JSON.parse(JSON.stringify(rawBehavior)) as Record<string, unknown>;
    return {
      name: id,
      matrixRow,
      rowIds,
      description: record.description,
      observedAt: new Date().toISOString(),
      fbSdkVersion,
      behavior,
    };
  } finally {
    await resetClientApps();
  }
}

export function selectClientStorageProbeId(
  args: readonly string[],
  knownIds: readonly string[] = [DEFAULT_ID],
): string {
  const probeFilter = readSingleProbeSelector(args);
  if (probeFilter !== undefined) {
    if (!knownIds.includes(probeFilter)) {
      throw new Error(`unknown client-storage probe: ${probeFilter}`);
    }
    return probeFilter;
  }
  return knownIds[0] ?? DEFAULT_ID;
}

function isStagedUncapturedProbe(
  item: LoadedClientStorageProbe,
  hasCommittedObservation: (id: string) => boolean,
): boolean {
  return item.probe.pendingRowLink === true && !hasCommittedObservation(item.id);
}

export function selectClientStorageProbes(
  loaded: readonly LoadedClientStorageProbe[],
  args: readonly string[],
  hasCommittedObservation: (id: string) => boolean = (id) => existsSync(observationPath(id)),
): LoadedClientStorageProbe[] {
  const probeFilter = readSingleProbeSelector(args);
  if (probeFilter !== undefined) {
    const matched = loaded.filter((item) => item.id === probeFilter);
    if (matched.length === 0) {
      throw new Error(`unknown client-storage probe: ${probeFilter}`);
    }
    return matched;
  }
  return loaded.filter((item) => !isStagedUncapturedProbe(item, hasCommittedObservation));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const loaded = await loadClientStorageProbes();
  const selected = selectClientStorageProbes(loaded, args);
  const fbSdkVersion = resolvedFirebaseVersion();
  const wantsWrite = args.includes('--write');

  if (wantsWrite) {
    for (const item of selected) {
      const outPath = observationPath(item.id);
      let existing = { matrixRow: '', rowIds: [] as string[] };
      if (existsSync(outPath)) {
        existing = readObservationLinkage(outPath);
      }
      const actual = await captureClientStorageObservation(
        item.probe,
        fbSdkVersion,
        item.id,
        existing,
      );
      writeFileSync(outPath, `${JSON.stringify(actual, null, 2)}\n`);
      console.log(`wrote ${item.id}.json against firebase ${fbSdkVersion}`);
    }
    return;
  }

  let allMatch = true;
  for (const item of selected) {
    const outPath = observationPath(item.id);
    if (!existsSync(outPath)) {
      console.log(`MISSING ${item.id} (installed ${fbSdkVersion})`);
      allMatch = false;
      continue;
    }
    const expected = JSON.parse(readFileSync(outPath, 'utf8')) as ObservationEnvelope;
    const actual = await captureClientStorageObservation(item.probe, fbSdkVersion, item.id);
    const matches =
      expected.fbSdkVersion === fbSdkVersion && deepEqual(expected.behavior, actual.behavior);
    let verdictLabel = 'MISMATCH';
    if (matches) {
      verdictLabel = 'MATCH';
    } else {
      allMatch = false;
    }
    console.log(
      `${verdictLabel} ${item.id} (captured ${expected.fbSdkVersion}, installed ${fbSdkVersion})`,
    );
  }
  process.exit(allMatch ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
