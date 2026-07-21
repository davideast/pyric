#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Probe } from '../rigs/types.ts';
import { probe } from '../probes/firestore/admin-firestore-document-snapshot-get.ts';

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

function installedAdminVersion(): string {
  const packagePath = fileURLToPath(import.meta.resolve('firebase-admin/package.json'));
  return (JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string }).version;
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

const adminSdkVersion = installedAdminVersion();
const actual = await capture(probe, adminSdkVersion);

if (process.argv.includes('--write')) {
  writeFileSync(OBSERVATION_PATH, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`wrote ${ID}.json against firebase-admin ${adminSdkVersion}`);
} else {
  const expected = JSON.parse(readFileSync(OBSERVATION_PATH, 'utf8')) as ObservationEnvelope;
  const matches = expected.adminSdkVersion === adminSdkVersion &&
    deepEqual(expected.behavior, actual.behavior);
  console.log(
    `${matches ? 'MATCH' : 'MISMATCH'} ${ID} ` +
      `(captured ${expected.adminSdkVersion}, installed ${adminSdkVersion})`,
  );
  process.exit(matches ? 0 : 1);
}
