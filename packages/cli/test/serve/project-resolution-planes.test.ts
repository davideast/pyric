/**
 * #1454: Every plane resolves the Firebase project for `.firebaserc`
 * deploy-target resolution the same way (`option`, `PYRIC_PROJECT`,
 * `pyric.json`, `firebase use` configstore, sole `.firebaserc` alias,
 * and `projects.default`, with `.firebaserc` alias resolution).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageRulesResolution } from 'pyric/storage/internal';

import {
  inProcessDefaultBucketName,
  loadProjectRules as loadBridgeProjectRules,
  openPersistedServices,
  saveSandboxSnapshot,
} from '../../src/bridge/server/in-process.js';
import { resolveFirebaseProject } from '../../src/cli/firebase-project.js';
import {
  loadInProcessFirestoreProjectRules,
  loadProjectFirestoreRules,
} from '../../src/serve/firestore-project-rules.js';
import { resolveFirestoreCandidateRules } from '../../src/verify/firestore-candidate-rules.js';

const TARGET_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /notes/{id} { allow read, write: if true; }',
  '  }',
  '}',
].join('\n');

const STORAGE_TARGET_RULES = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    match /assets/{allPaths=**} { allow read: if true; }',
  '  }',
  '}',
].join('\n');

const dirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function writeMultiAliasProject(dir: string): Record<string, unknown> {
  const firebaseJson = {
    firestore: [{ target: 'main', rules: 'target.rules' }],
    storage: [{ target: 'media', rules: 'storage.target.rules' }],
  };
  const firebaseRc = {
    projects: {
      staging: 'staging-proj',
      prod: 'prod-proj',
    },
    targets: {
      'staging-proj': {
        firestore: { main: ['(default)', 'reports'] },
        storage: { media: ['staging-proj.firebasestorage.app'] },
      },
    },
  };
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify(firebaseJson));
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify(firebaseRc));
  writeFileSync(join(dir, 'target.rules'), TARGET_RULES);
  writeFileSync(join(dir, 'storage.target.rules'), STORAGE_TARGET_RULES);
  return firebaseJson;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('cross-plane Firebase project selection for .firebaserc deploy targets (#1454)', () => {
  it('agrees across dev server, in-process bridge, and pyric verify under PYRIC_PROJECT, pyric.json, and firebase use', async () => {
    const cleanHome = makeTempDir('pyric-1454-home-');
    const prevProject = process.env.PYRIC_PROJECT;
    const prevHome = process.env.HOME;
    const prevXdg = process.env.XDG_CONFIG_HOME;

    try {
      process.env.HOME = cleanHome;
      delete process.env.XDG_CONFIG_HOME;

      const assertAllPlanesResolve = async (dir: string, config: Record<string, unknown>): Promise<void> => {
        const expectedPath = join(dir, 'target.rules');
        const resolvedProject = resolveFirebaseProject({ projectDir: dir });
        expect(resolvedProject.projectId).toBe('staging-proj');

        const devLoaded = await loadProjectFirestoreRules(dir, config, resolvedProject);
        expect(devLoaded.sourcePath).toBe(expectedPath);
        expect(devLoaded.declared.has('reports')).toBe(true);
        expect(devLoaded.pending).toEqual([]);

        const inProcWarnings: string[] = [];
        const inProcLoaded = loadInProcessFirestoreProjectRules(
          initializeSandbox(),
          dir,
          config,
          undefined,
          join(dir, '.pyric', 'state', 'in-process.json'),
          (msg) => inProcWarnings.push(msg),
        );
        expect(inProcWarnings).toEqual([]);
        expect(inProcLoaded).toEqual({ path: expectedPath, refused: null });

        // Bridge in-process server plane: default bucket name, Storage target
        // rules, loadProjectRules, and diskAtSave snapshot capture (#1454).
        expect(inProcessDefaultBucketName(dir)).toBe('staging-proj.firebasestorage.app');
        const bridgeSandbox = initializeSandbox();
        const storageHandle = openPersistedServices(bridgeSandbox, dir);
        expect(getStorageRulesResolution(storageHandle)?.source).toBe(STORAGE_TARGET_RULES);
        const bridgeLoaded = loadBridgeProjectRules(bridgeSandbox, dir);
        expect(bridgeLoaded).toEqual({ path: expectedPath, refused: null });
        saveSandboxSnapshot(bridgeSandbox, dir);

        const verifyLoaded = await resolveFirestoreCandidateRules({
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
                  path: 'notes/1',
                  auth: null,
                  allowed: true,
                  at: 0,
                },
              ],
            } as never,
          ],
          overrides: { databases: [] },
          readFirebaseJson: async () => config,
        });
        expect(verifyLoaded.paths.firestore).toBe(expectedPath);
      };

      // 1. PYRIC_PROJECT alias
      const envDir = makeTempDir('pyric-1454-env-');
      const envConfig = writeMultiAliasProject(envDir);
      process.env.PYRIC_PROJECT = 'staging';
      await assertAllPlanesResolve(envDir, envConfig);

      // 2. pyric.json project
      delete process.env.PYRIC_PROJECT;
      const cfgDir = makeTempDir('pyric-1454-cfg-');
      const cfgConfig = writeMultiAliasProject(cfgDir);
      writeFileSync(join(cfgDir, 'pyric.json'), JSON.stringify({ project: 'staging' }));
      await assertAllPlanesResolve(cfgDir, cfgConfig);

      // 3. firebase use activeProjects in configstore
      const useDir = makeTempDir('pyric-1454-use-');
      const useConfig = writeMultiAliasProject(useDir);
      mkdirSync(join(cleanHome, '.config', 'configstore'), { recursive: true });
      writeFileSync(
        join(cleanHome, '.config', 'configstore', 'firebase-tools.json'),
        JSON.stringify({ activeProjects: { [useDir]: 'staging' } }),
      );
      await assertAllPlanesResolve(useDir, useConfig);

      // 4. --project alias on pyric verify overrides firebase use
      const overrideDir = makeTempDir('pyric-1454-flag-');
      const overrideConfig = writeMultiAliasProject(overrideDir);
      writeFileSync(
        join(cleanHome, '.config', 'configstore', 'firebase-tools.json'),
        JSON.stringify({ activeProjects: { [overrideDir]: 'prod' } }),
      );
      const verifyOverride = await resolveFirestoreCandidateRules({
        cwd: overrideDir,
        project: 'staging',
        fixtures: [
          {
            version: 1,
            services: { firestore: {} },
            events: [
              {
                kind: 'read',
                service: 'firestore',
                method: 'get',
                path: 'notes/1',
                auth: null,
                allowed: true,
                at: 0,
              },
            ],
          } as never,
        ],
        overrides: { databases: [] },
        readFirebaseJson: async () => overrideConfig,
      });
      expect(verifyOverride.paths.firestore).toBe(join(overrideDir, 'target.rules'));
    } finally {
      if (prevProject === undefined) delete process.env.PYRIC_PROJECT;
      else process.env.PYRIC_PROJECT = prevProject;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });
});
