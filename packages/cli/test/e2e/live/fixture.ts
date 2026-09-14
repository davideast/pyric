import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { startLiveEmulators } from './emulators.js';

export type LiveBackend = Awaited<ReturnType<typeof startLiveEmulators>>;

/** Install the same normal application and Firebase dependency in either entry path. */
export function prepareLiveFixture(dir: string, backend: LiveBackend): void {
  symlinkSync(fileURLToPath(new URL('../../../node_modules/', import.meta.url)), join(dir, 'node_modules'), 'dir');
  for (const name of ['index.html', 'main.js']) {
    writeFileSync(join(dir, name), readFileSync(new URL(`./fixture/${name}`, import.meta.url)));
  }
  writeFileSync(join(dir, 'test-backend.json'), JSON.stringify(backend));
  writeFileSync(join(dir, 'firestore.rules'), backend.rules);
}
