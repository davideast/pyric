/**
 * #1452: An object `firestore` block with no `rules` key in `firebase.json`
 * serves no Firestore rules file across dev server, in-process bridge, and
 * `pyric verify`, even when `<projectDir>/firestore.rules` exists on disk.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doc, getFirestore, setDoc } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';

import {
  loadInProcessFirestoreProjectRules,
  loadProjectFirestoreRules,
} from '../../src/serve/firestore-project-rules.js';
import { loadProjectRules as loadDevProjectRules } from '../../src/serve/rules.js';
import { resolveFirestoreCandidateRules } from '../../src/verify/firestore-candidate-rules.js';

const DENY_ALL_DECOY_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if false; }',
  '  }',
  '}',
].join('\n');

const dirs: string[] = [];

function makeProject(firebaseJson: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-1452-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify(firebaseJson));
  writeFileSync(join(dir, 'firestore.rules'), DENY_ALL_DECOY_RULES);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('object firestore block with no rules key (#1452)', () => {
  it('serves no Firestore rules on dev server, in-process bridge, or verify for { indexes }', async () => {
    const config = { firestore: { indexes: 'firestore.indexes.json' } };
    const dir = makeProject(config);

    const devSingle = await loadDevProjectRules(dir, config);
    expect(devSingle.rules).toBeNull();
    expect(devSingle.sourcePath).toBeNull();

    const devMulti = await loadProjectFirestoreRules(dir, config);
    expect(devMulti.rules).toBeNull();
    expect(devMulti.sourcePath).toBeNull();

    const inProcSandbox = initializeSandbox();
    const warnings: string[] = [];
    const inProcLoaded = loadInProcessFirestoreProjectRules(
      inProcSandbox,
      dir,
      config,
      undefined,
      join(dir, '.pyric', 'state', 'in-process.json'),
      (msg) => warnings.push(msg),
    );
    expect(inProcLoaded).toBeNull();
    expect(warnings).toEqual([]);
    await setDoc(doc(getFirestore(inProcSandbox.withAuth(null)), 'items/1'), { v: 1 });

    await expect(
      resolveFirestoreCandidateRules({
        cwd: dir,
        fixtures: [
          {
            version: 1,
            services: { firestore: {} },
            events: [
              {
                kind: 'read',
                service: 'firestore',
                method: 'get',
                path: 'items/1',
                auth: null,
                allowed: true,
                at: 0,
              },
            ],
          } as never,
        ],
        overrides: { databases: [] },
        readFirebaseJson: async () => config,
      }),
    ).rejects.toThrow(/missing candidate firestore rules/);
  });

  it('declares a named database locked without serving firestore.rules on (default) for { database }', async () => {
    const config = { firestore: { database: 'reports' } };
    const dir = makeProject(config);

    const devMulti = await loadProjectFirestoreRules(dir, config);
    expect(devMulti.rules).toBeNull();
    expect(devMulti.sourcePath).toBeNull();
    expect(devMulti.declared.has('reports')).toBe(true);
    expect(devMulti.databases.get('reports')?.rules).toBeNull();
  });
});
