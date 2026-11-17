#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Probe } from '../rigs/types.ts';
import { probe } from '../probes/storage-admin/admin-storage-metadata-download-url.ts';
import { oracleCredentialConfigured } from './oracle-credential.ts';
import { resolvedAdminVersion } from './package-version.ts';
import {
  formatInertPreviewFooter,
  requireCaptureMode,
  stripCaptureFlags,
} from './capture-mode-guard.ts';
import { resolveProbeObservationLinkage } from './observation-linkage.ts';
import { readSingleProbeSelector } from './probe-cli-args.ts';
export { resolveAdminStorageBucket } from './storage-probe-session.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = 'admin-storage-metadata-download-url';
const OBSERVATION_PATH = join(HERE, '..', 'observations', 'storage-admin', `${ID}.json`);

interface ObservationEnvelope {
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  observedAt: string;
  adminSdkVersion: string;
  behavior: Record<string, unknown>;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((value, index) => deepEqual(value, b[index]));
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

async function capture(
  record: Probe,
  adminSdkVersion: string,
  observationPath = OBSERVATION_PATH,
): Promise<ObservationEnvelope> {
  const linkage = resolveProbeObservationLinkage(record, observationPath);
  return {
    name: ID,
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
  observationPath = OBSERVATION_PATH,
): Promise<void> {
  const actual = await capture(record, adminSdkVersion, observationPath);
  writeFileSync(observationPath, `${JSON.stringify(actual, null, 2)}\n`);
}

export function selectStorageAdminProbeId(args: readonly string[]): string {
  const probeFilter = readSingleProbeSelector(args);
  if (probeFilter !== undefined && probeFilter !== ID) {
    throw new Error(`unknown storage-admin probe: ${probeFilter}`);
  }
  return ID;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  selectStorageAdminProbeId(stripCaptureFlags(args));
  const wantsVerify = args.includes('--verify');
  if (!wantsVerify) {
    requireCaptureMode({
      label: 'storage-admin-probes',
      scriptPath: 'packages/conformance/src/storage-admin-probes.ts',
      argv: args,
      preview: () => {
        console.log(`[storage-admin-probes] INERT preview for ${ID}.`);
        console.log(`  ${formatInertPreviewFooter('packages/conformance/src/storage-admin-probes.ts')}`);
      },
      missingCredentials: () => {
        if (oracleCredentialConfigured(process.env)) return null;
        return 'PYRIC_ORACLE_SA_PATH or PYRIC_ORACLE_PROJECT_ID';
      },
    });
  }
  const wantsWrite = !wantsVerify;
  const adminSdkVersion = resolvedAdminVersion();

  if (wantsWrite) {
    await writeStorageAdminObservation(probe, adminSdkVersion, OBSERVATION_PATH);
    console.log(`wrote ${ID}.json against firebase-admin ${adminSdkVersion}`);
    return;
  }
  const actual = await capture(probe, adminSdkVersion, OBSERVATION_PATH);
  const expected = JSON.parse(readFileSync(OBSERVATION_PATH, 'utf8')) as ObservationEnvelope;
  const matches = expected.adminSdkVersion === adminSdkVersion &&
    deepEqual(expected.behavior, actual.behavior);
  const verdictLabel = matches ? 'MATCH' : 'MISMATCH';
  console.log(
    `${verdictLabel} ${ID} ` +
      `(captured ${expected.adminSdkVersion}, installed ${adminSdkVersion})`,
  );
  process.exit(matches ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
