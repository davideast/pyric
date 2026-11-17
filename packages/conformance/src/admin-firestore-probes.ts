#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Probe } from '../rigs/types.ts';
import { probe } from '../probes/firestore/admin-firestore-document-snapshot-get.ts';
import { oracleCredentialConfigured } from './oracle-credential.ts';
import { resolvedAdminVersion } from './package-version.ts';
import {
  formatInertPreviewFooter,
  requireCaptureMode,
  stripCaptureFlags,
} from './capture-mode-guard.ts';
import { readSingleProbeSelector } from './probe-cli-args.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = 'admin-firestore-document-snapshot-get';
const OBSERVATION_PATH = join(HERE, '..', 'observations', 'firestore', `${ID}.json`);

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

async function capture(record: Probe, adminSdkVersion: string): Promise<ObservationEnvelope> {
  return {
    name: ID,
    matrixRow: record.matrixRow,
    rowIds: record.rowIds,
    description: record.description,
    observedAt: new Date().toISOString(),
    adminSdkVersion,
    behavior: await record.observe(),
  };
}

export function selectAdminFirestoreProbeId(args: readonly string[]): string {
  const probeFilter = readSingleProbeSelector(args);
  if (probeFilter !== undefined && probeFilter !== ID) {
    throw new Error(`unknown admin-firestore probe: ${probeFilter}`);
  }
  return ID;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  selectAdminFirestoreProbeId(stripCaptureFlags(args));
  const wantsVerify = args.includes('--verify');
  if (!wantsVerify) {
    requireCaptureMode({
      label: 'admin-firestore-probes',
      scriptPath: 'packages/conformance/src/admin-firestore-probes.ts',
      argv: args,
      preview: () => {
        console.log(`[admin-firestore-probes] INERT preview for ${ID}.`);
        console.log(`  ${formatInertPreviewFooter('packages/conformance/src/admin-firestore-probes.ts')}`);
      },
      missingCredentials: () => {
        if (oracleCredentialConfigured(process.env)) return null;
        return 'PYRIC_ORACLE_SA_PATH or PYRIC_ORACLE_PROJECT_ID';
      },
    });
  }
  const wantsWrite = !wantsVerify;
  const adminSdkVersion = resolvedAdminVersion();
  const actual = await capture(probe, adminSdkVersion);

  if (wantsWrite) {
    writeFileSync(OBSERVATION_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`wrote ${ID}.json against firebase-admin ${adminSdkVersion}`);
    return;
  }
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
