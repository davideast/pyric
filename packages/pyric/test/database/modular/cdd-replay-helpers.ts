import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, sandbox as databaseSandbox, type DataSnapshot } from '../../../src/database/index.js';

const OBS_DIR = join(
  import.meta.dir,
  '..', '..', '..', '..', '..',
  'packages', 'conformance', 'observations', 'rtdb-modular',
);

export function loadObservation(name: string): Record<string, any> {
  return (JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as {
    behavior: Record<string, any>;
  }).behavior;
}

export function setup() {
  const sandbox = initializeSandbox();
  const first = getDatabase(sandbox.withAuth({ uid: 'first' }));
  const second = getDatabase(sandbox.withAuth({ uid: 'second' }));
  databaseSandbox.setDefaultPolicy(first, 'allow');
  return {
    sandbox,
    first,
    second,
  };
}

export function keys(snapshot: DataSnapshot): string[] {
  const result: string[] = [];
  snapshot.forEach((child) => { if (child.key) result.push(child.key); });
  return result;
}

export function cancellationShape(error: Error, path: string): Record<string, unknown> {
  return {
    name: error.name,
    code: (error as Error & { code?: string }).code ?? null,
    message: error.message.replace(path, '<path>'),
  };
}
