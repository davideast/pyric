/**
 * Writes `app-check-` observations in the house format, refusing any file whose
 * serialized form still contains a secret value.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvedAdminVersion, resolvedFirebaseVersion } from '../../package-version.ts';
import { allCompatibilityRows } from '../../../registry/index.ts';
import { redactJson, type Secrets } from './redact.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSERVATIONS = join(HERE, '..', '..', '..', 'observations');

/** `app-check-admin-` captures belong to the app-check-admin surface; the rest to app-check. */
export function observationPath(name: string): string {
  const surfaceDir = name.startsWith('app-check-admin-') ? 'app-check-admin' : 'app-check';
  return join(OBSERVATIONS, surfaceDir, `${name}.json`);
}

/** The registry rows that cite this capture: the observation side of the link. */
export function citingRowIds(name: string): string[] {
  return allCompatibilityRows.filter((row) => row.oracleObservations.includes(name)).map((row) => row.id).sort();
}

export interface ObservationContext {
  projectId: string;
  secrets: Secrets;
}

export function assertNoSecret(serialized: string, secrets: Secrets, name: string): void {
  const leaked = [secrets.appId, secrets.apiKey, ...secrets.values].filter((value) => value && serialized.includes(value));
  if (leaked.length > 0) throw new Error(`${name}: refusing to write an observation that contains a secret value`);
}

export function writeObservation(
  context: ObservationContext,
  name: string,
  description: string,
  behavior: Record<string, unknown>,
  plane: 'admin' | 'client',
): void {
  const observation = {
    name,
    matrixRow: '',
    rowIds: citingRowIds(name),
    description,
    observedAt: new Date().toISOString(),
    fbSdkVersion: resolvedFirebaseVersion(),
    ...(plane === 'admin' ? { adminSdkVersion: resolvedAdminVersion() } : {}),
    projectId: context.projectId,
    behavior: redactJson(behavior, context.secrets),
  };
  const serialized = `${JSON.stringify(observation, null, 2)}\n`;
  assertNoSecret(serialized, context.secrets, name);
  const path = observationPath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialized);
  console.log(`wrote ${name}`);
}
