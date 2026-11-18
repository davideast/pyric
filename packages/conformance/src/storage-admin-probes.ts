#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Probe } from '../rigs/types.ts';
import {
  formatInertPreviewFooter,
  requireCaptureMode,
  stripCaptureFlags,
} from './capture-mode-guard.ts';
import {
  resolveProbeObservationLinkage,
  shouldIncludeProbeInUnfilteredRun,
} from './observation-linkage.ts';
import { oracleCredentialConfigured } from './oracle-credential.ts';
import { resolvedAdminVersion } from './package-version.ts';
import { readSingleProbeSelector } from './probe-cli-args.ts';
export { resolveAdminStorageBucket } from './storage-probe-session.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBES_DIR = join(HERE, '..', 'probes', 'storage-admin');
const OBS_DIR = join(HERE, '..', 'observations', 'storage-admin');
const PREFIX = 'admin-storage-';
const DEFAULT_ID = 'admin-storage-metadata-download-url';
const DEFAULT_OBSERVATION_PATH = join(OBS_DIR, `${DEFAULT_ID}.json`);

interface ObservationEnvelope {
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  observedAt: string;
  adminSdkVersion: string;
  behavior: Record<string, unknown>;
}

export interface LoadedStorageAdminProbe {
  id: string;
  probe: Probe;
}

function observationPathFor(id: string): string {
  return join(OBS_DIR, `${id}.json`);
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

export async function loadStorageAdminProbes(): Promise<LoadedStorageAdminProbe[]> {
  const files = readdirSync(PROBES_DIR)
    .filter((file) => file.startsWith(PREFIX) && file.endsWith('.ts'))
    .sort();
  const loaded: LoadedStorageAdminProbe[] = [];
  for (const file of files) {
    const id = file.slice(0, -'.ts'.length);
    const mod = (await import(pathToFileURL(join(PROBES_DIR, file)).href)) as { probe?: Probe };
    if (!mod.probe || typeof mod.probe.observe !== 'function') {
      throw new Error(
        `probes/storage-admin/${file}: does not export a 'probe' record with an observe() method`,
      );
    }
    loaded.push({ id, probe: mod.probe });
  }
  return loaded;
}

async function capture(
  record: Probe,
  adminSdkVersion: string,
  observationPath = DEFAULT_OBSERVATION_PATH,
  id = DEFAULT_ID,
): Promise<ObservationEnvelope> {
  const linkage = resolveProbeObservationLinkage(record, observationPath);
  return {
    name: id,
    matrixRow: linkage.matrixRow,
    rowIds: linkage.rowIds,
    description: record.description,
    observedAt: new Date().toISOString(),
    adminSdkVersion,
    behavior: await record.observe(),
  };
}

export async function writeStorageAdminObservation(
  record: Probe,
  adminSdkVersion: string,
  observationPath = DEFAULT_OBSERVATION_PATH,
  id = DEFAULT_ID,
): Promise<void> {
  const actual = await capture(record, adminSdkVersion, observationPath, id);
  writeFileSync(observationPath, `${JSON.stringify(actual, null, 2)}\n`);
}

export function selectStorageAdminProbeId(args: readonly string[]): string {
  const probeFilter = readSingleProbeSelector(args);
  if (probeFilter !== undefined && probeFilter !== DEFAULT_ID) {
    throw new Error(`unknown storage-admin probe: ${probeFilter}`);
  }
  return DEFAULT_ID;
}

export function selectStorageAdminProbes(
  loaded: readonly LoadedStorageAdminProbe[],
  args: readonly string[],
  resolvePath: (id: string) => string = observationPathFor,
): LoadedStorageAdminProbe[] {
  const probeFilter = readSingleProbeSelector(stripCaptureFlags(args));
  if (probeFilter !== undefined) {
    const matched = loaded.filter((item) => item.id === probeFilter);
    if (matched.length === 0) {
      throw new Error(`unknown storage-admin probe: ${probeFilter}`);
    }
    return matched;
  }
  return loaded.filter((item) =>
    shouldIncludeProbeInUnfilteredRun(item.probe, resolvePath(item.id)),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const loaded = await loadStorageAdminProbes();
  const selected = selectStorageAdminProbes(loaded, args);
  const wantsVerify = args.includes('--verify');
  if (!wantsVerify) {
    requireCaptureMode({
      label: 'storage-admin-probes',
      scriptPath: 'packages/conformance/src/storage-admin-probes.ts',
      argv: args,
      preview: () => {
        const ids = selected.map((item) => item.id).join(', ');
        console.log(`[storage-admin-probes] INERT preview for ${ids}.`);
        console.log(
          `  ${formatInertPreviewFooter('packages/conformance/src/storage-admin-probes.ts')}`,
        );
      },
      missingCredentials: () => {
        if (oracleCredentialConfigured(process.env)) return null;
        return 'PYRIC_ORACLE_SA_PATH or PYRIC_ORACLE_PROJECT_ID';
      },
    });
  }
  const adminSdkVersion = resolvedAdminVersion();

  if (!wantsVerify) {
    for (const item of selected) {
      const outPath = observationPathFor(item.id);
      await writeStorageAdminObservation(item.probe, adminSdkVersion, outPath, item.id);
      console.log(`wrote ${item.id}.json against firebase-admin ${adminSdkVersion}`);
    }
    return;
  }

  let allMatch = true;
  for (const item of selected) {
    const outPath = observationPathFor(item.id);
    if (!existsSync(outPath)) {
      console.log(`MISSING ${item.id} (installed ${adminSdkVersion})`);
      allMatch = false;
      continue;
    }
    const actual = await capture(item.probe, adminSdkVersion, outPath, item.id);
    const expected = JSON.parse(readFileSync(outPath, 'utf8')) as ObservationEnvelope;
    const matches =
      expected.adminSdkVersion === adminSdkVersion &&
      deepEqual(expected.behavior, actual.behavior);
    let verdictLabel = 'MISMATCH';
    if (matches) {
      verdictLabel = 'MATCH';
    } else {
      allMatch = false;
    }
    console.log(
      `${verdictLabel} ${item.id} (captured ${expected.adminSdkVersion}, installed ${adminSdkVersion})`,
    );
  }
  let exitCode = 1;
  if (allMatch) {
    exitCode = 0;
  }
  process.exit(exitCode);
}

if (import.meta.main) {
  await main();
}
