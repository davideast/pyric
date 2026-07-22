import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readObservationLinkage } from './observation-linkage.ts';
import { type RequestBudget } from './storage-stdlib-real-budget.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, '..', 'observations', 'storage-rules');

function resolvedFirebaseVersion(): string {
  const packagePath = fileURLToPath(import.meta.resolve('firebase/package.json'));
  return (JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string }).version;
}

export function writeStorageObservations(values: Array<Record<string, unknown>>): void {
  mkdirSync(OBS_DIR, { recursive: true });
  for (const value of values) {
    const path = join(OBS_DIR, `${value.name as string}.json`);
    const linkage = readObservationLinkage(path);
    writeFileSync(path, `${JSON.stringify({ ...value, ...linkage }, null, 2)}\n`);
    console.log(`[storage-stdlib:remaining] wrote ${path}`);
  }
}

export function storageObservation(
  name: string,
  description: string,
  projectId: string,
  bucket: string,
  behavior: Record<string, unknown>,
  diagnostics: Record<string, unknown>,
  cleanup: Record<string, boolean>,
  budget: RequestBudget,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    matrixRow: '',
    rowIds: [],
    description,
    observedAt: new Date().toISOString(),
    fbSdkVersion: resolvedFirebaseVersion(),
    projectId,
    bucket,
    behavior,
    diagnostics,
    cleanup,
    requestBudget: budget.snapshot(),
    ...extra,
  };
}
