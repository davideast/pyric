/**
 * Writes `app-check-` observations in the house format, refusing any file whose
 * serialized form still contains a secret value.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvedAdminVersion, resolvedFirebaseVersion } from '../../package-version.ts';
import { redactJson, type Secrets } from './redact.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OBS_DIR = join(HERE, '..', '..', '..', 'observations', 'app-check');

const PRE_ADMISSION =
  ' rowIds empty: the app-check surface is climbing under CDD and this capture is parked in exceptions/ until a row cites it.';

export interface ObservationContext {
  projectId: string;
  secrets: Secrets;
}

function assertNoSecret(serialized: string, secrets: Secrets, name: string): void {
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
    rowIds: [],
    description: `${description}${PRE_ADMISSION}`,
    observedAt: new Date().toISOString(),
    fbSdkVersion: resolvedFirebaseVersion(),
    ...(plane === 'admin' ? { adminSdkVersion: resolvedAdminVersion() } : {}),
    projectId: context.projectId,
    behavior: redactJson(behavior, context.secrets),
  };
  const serialized = `${JSON.stringify(observation, null, 2)}\n`;
  assertNoSecret(serialized, context.secrets, name);
  mkdirSync(OBS_DIR, { recursive: true });
  writeFileSync(join(OBS_DIR, `${name}.json`), serialized);
  console.log(`wrote ${name}`);
}
