#!/usr/bin/env bun
/**
 * Client Storage oracle runner.
 *
 * Runs the probe in `probes/storage/client-storage-ref-urls.ts` against the
 * INSTALLED `firebase/storage` package. `ref(storage, url)` parses its URL in
 * the client, so the probe needs no credentials, no project, and no network;
 * see `../rigs/client-storage.ts` for the rig manifest.
 *
 * Two modes:
 *   verify (default) — runs the probe in memory and compares its result with the
 *     committed observation's `behavior` and `fbSdkVersion`. Writes nothing.
 *     Exits 1 on any difference.
 *   --write — overwrites the observation with a fresh capture.
 *
 * Usage:
 *   bun run packages/conformance/src/client-storage-probes.ts            # verify
 *   bun run packages/conformance/src/client-storage-probes.ts --write    # recapture
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Probe } from '../rigs/types.ts';
import { probe } from '../probes/storage/client-storage-ref-urls.ts';
import { resolvedFirebaseVersion } from './package-version.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = 'client-storage-ref-urls';
const OBSERVATION_PATH = join(HERE, '..', 'observations', 'storage', `${ID}.json`);

interface ObservationEnvelope {
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  observedAt: string;
  fbSdkVersion: string;
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

async function capture(record: Probe, fbSdkVersion: string): Promise<ObservationEnvelope> {
  return {
    name: ID,
    matrixRow: record.matrixRow,
    rowIds: record.rowIds,
    description: record.description,
    observedAt: new Date().toISOString(),
    fbSdkVersion,
    // A JSON round trip drops fields a probe left undefined, as the committed file does.
    behavior: JSON.parse(JSON.stringify(await record.observe())) as Record<string, unknown>,
  };
}

const fbSdkVersion = resolvedFirebaseVersion();
const actual = await capture(probe, fbSdkVersion);

if (process.argv.includes('--write')) {
  writeFileSync(OBSERVATION_PATH, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`wrote ${ID}.json against firebase ${fbSdkVersion}`);
} else {
  const expected = JSON.parse(readFileSync(OBSERVATION_PATH, 'utf8')) as ObservationEnvelope;
  const matches = expected.fbSdkVersion === fbSdkVersion &&
    deepEqual(expected.behavior, actual.behavior);
  console.log(
    `${matches ? 'MATCH' : 'MISMATCH'} ${ID} ` +
      `(captured ${expected.fbSdkVersion}, installed ${fbSdkVersion})`,
  );
  process.exit(matches ? 0 : 1);
}
