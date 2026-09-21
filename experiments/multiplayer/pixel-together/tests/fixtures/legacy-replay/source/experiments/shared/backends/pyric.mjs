import { initializeSandbox } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import * as firestore from 'pyric/firestore';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

function digestTree(directory) {
  const digest = createHash('sha256');
  const visit = (path, relative = '') => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(join(path, entry.name), key);
      else if (entry.isFile()) digest.update(key).update('\0').update(readFileSync(join(path, entry.name))).update('\0');
    }
  };
  visit(directory);
  return digest.digest('hex');
}

// A future Firebase driver must implement this contract with independently
// authenticated Web SDK clients, isolated fixture provisioning, and cleanup.
export const pyricBackend = {
  sdk: firestore,
  environment: {
    backend: 'pyric', production: false,
    sdk: JSON.parse(readFileSync(new URL(import.meta.resolve('pyric/package.json')))).version,
    entrypointHash: createHash('sha256').update(readFileSync(new URL(import.meta.resolve('pyric/firestore')))).digest('hex'),
    builtPackageHash: digestTree(fileURLToPath(new URL('./dist', import.meta.resolve('pyric/package.json')))),
    adapterHash: createHash('sha256').update(readFileSync(new URL('./pyric.mjs', import.meta.url))).digest('hex'),
    transport: 'in-process', clock: 'local wall clock; no latency injection',
  },
  async create({ rules, fixture }) {
    const sandbox = initializeSandbox();
    setRules(sandbox, rules);
    seedDocuments(sandbox, structuredClone(fixture));
    return { client: uid => firestore.getFirestore(sandbox.withAuth(uid ? { uid } : null)), close: async () => {} };
  },
};
