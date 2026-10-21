import assert from 'node:assert/strict';
import { initializeSandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { getStorageSandbox, ref, uploadBytes } from 'pyric/storage';
import { installStorageBackend } from 'pyric/storage/internal';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';

// Object generations on the Node host's SQLite store (issue #1160): overwrites
// under a fixed clock, and an overwrite after the host restarts under the same
// clock, each get a new, larger generation.
const RULES = "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if true; } } }";
const FIXED_AT = Date.UTC(2030, 0, 1);
const directory = process.argv[2];

async function writeTwice(): Promise<string[]> {
  const database = await openHostedDatabase(directory);
  try {
    const sandbox = initializeSandbox();
    installStorageBackend(sandbox, database.storage);
    getClock(sandbox).set(FIXED_AT);
    const storage = getStorageSandbox(sandbox, { rules: RULES });
    const generations: string[] = [];
    for (const body of ['a', 'b']) {
      const result = await uploadBytes(ref(storage, 'media/clip.bin'), new Blob([body]));
      generations.push(result.metadata.generation);
    }
    return generations;
  } finally { database.close(); }
}

const before = await writeTwice();
const after = await writeTwice();
const all = [...before, ...after];
for (let i = 1; i < all.length; i++) assert.ok(BigInt(all[i]!) > BigInt(all[i - 1]!), `generations ${all.join(', ')} do not increase`);
console.log('Storage generations passed');
