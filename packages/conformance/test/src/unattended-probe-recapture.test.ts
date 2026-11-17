import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rig as adminFirestoreRig } from '../../rigs/admin-firestore.ts';
import { rig as storageAdminRig } from '../../rigs/storage-admin.ts';
import type { Probe } from '../../rigs/types.ts';
import {
  observationLinkageOf,
  readObservationLinkage,
  resolveProbeObservationLinkage,
  shouldIncludeProbeInUnfilteredRun,
} from '../../src/observation-linkage.ts';
import { writeAdminAppObservations } from '../../src/admin-app-probes.ts';
import { writeAdminFirestoreObservation } from '../../src/admin-firestore-probes.ts';
import { writeAppRegistryObservations } from '../../src/app-registry-probes.ts';
import { createProbe as createAdminQueryIndexProbe } from '../../src/capture/rtdb-climb/admin-query-index.probe.ts';
import { selectModularProbes, type LoadedModularProbe } from '../../src/sdk-probes.ts';
import { resolveAdminStorageBucket, writeStorageAdminObservation } from '../../src/storage-admin-probes.ts';

describe('unattended probe recapture linkage and staged-probe filtering', () => {
  test('preserves committed rowIds and matrixRow when a probe leaves them empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-link-'));
    try {
      const obsPath = join(dir, 'admin-app-accessors-resolve-default.json');
      writeFileSync(
        obsPath,
        JSON.stringify({
          name: 'admin-app-accessors-resolve-default',
          matrixRow: 'auth-admin.default-app',
          rowIds: ['auth-admin#1', 'firestore-admin#1'],
          behavior: { ok: true },
        }),
      );
      const unlinkedProbe = {
        description: 'default app accessors',
        matrixRow: '',
        rowIds: [],
        async observe() {
          return { ok: true };
        },
      } satisfies Probe;

      expect(resolveProbeObservationLinkage(unlinkedProbe, obsPath)).toEqual({
        matrixRow: 'auth-admin.default-app',
        rowIds: ['auth-admin#1', 'firestore-admin#1'],
      });

      const explicitProbe = {
        ...unlinkedProbe,
        matrixRow: 'override.row',
        rowIds: ['rtdb-admin#1'],
      } satisfies Probe;
      expect(resolveProbeObservationLinkage(explicitProbe, obsPath)).toEqual({
        matrixRow: 'override.row',
        rowIds: ['rtdb-admin#1'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips uncaptured pendingRowLink probes in unfiltered runs while running captured or targeted ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-staged-'));
    try {
      const capturedPath = join(dir, 'captured.json');
      const uncapturedPath = join(dir, 'uncaptured.json');
      writeFileSync(capturedPath, '{"name":"captured"}');

      const stagedProbe: Probe = {
        description: 'staged probe',
        matrixRow: '',
        rowIds: [],
        pendingRowLink: true,
        async observe() {
          return { ok: true };
        },
      };

      expect(shouldIncludeProbeInUnfilteredRun(stagedProbe, uncapturedPath)).toBe(false);
      expect(shouldIncludeProbeInUnfilteredRun(stagedProbe, capturedPath)).toBe(true);
      expect(
        shouldIncludeProbeInUnfilteredRun({ ...stagedProbe, pendingRowLink: false }, uncapturedPath),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('admin-app and app-registry --write preserve committed rowIds without clobbering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-unattended-write-'));
    try {
      const adminObsPath = join(dir, 'admin-app-sample.json');
      writeFileSync(
        adminObsPath,
        JSON.stringify({
          name: 'admin-app-sample',
          matrixRow: '',
          rowIds: ['auth-admin#1', 'firestore-admin#1'],
          description: 'sample admin probe',
          observedAt: '2026-07-08T00:00:00.000Z',
          adminSdkVersion: '13.10.0',
          behavior: { old: true },
        }),
      );
      await writeAdminAppObservations(
        [
          {
            id: 'admin-app-sample',
            probe: {
              description: 'sample admin probe',
              matrixRow: '',
              rowIds: [],
              async observe() {
                return { fresh: true };
              },
            },
          },
        ],
        '13.10.0',
        dir,
      );
      const writtenAdmin = JSON.parse(readFileSync(adminObsPath, 'utf8'));
      expect(writtenAdmin.rowIds).toEqual(['auth-admin#1', 'firestore-admin#1']);
      expect(writtenAdmin.behavior).toEqual({ fresh: true });

      const appObsPath = join(dir, 'app-registry-sample.json');
      writeFileSync(
        appObsPath,
        JSON.stringify({
          name: 'app-registry-sample',
          matrixRow: 'app#1',
          rowIds: ['app#1'],
          description: 'sample app probe',
          observedAt: '2026-07-08T00:00:00.000Z',
          fbSdkVersion: '12.19.0',
          behavior: { old: true },
        }),
      );
      await writeAppRegistryObservations(
        [
          {
            id: 'app-registry-sample',
            probe: {
              description: 'sample app probe',
              matrixRow: '',
              rowIds: [],
              async observe() {
                return { fresh: true };
              },
            },
          },
        ],
        '12.19.0',
        dir,
      );
      const writtenApp = JSON.parse(readFileSync(appObsPath, 'utf8'));
      expect(writtenApp.rowIds).toEqual(['app#1']);
      expect(writtenApp.matrixRow).toBe('app#1');
      expect(writtenApp.behavior).toEqual({ fresh: true });

      expect(observationLinkageOf(readObservationLinkage(adminObsPath))).toEqual({
        matrixRow: '',
        rowIds: ['auth-admin#1', 'firestore-admin#1'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('selectModularProbes skips uncaptured pendingRowLink probes only when includeUncapturedStaged is false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-modular-staged-'));
    try {
      const firestoreDir = join(dir, 'firestore');
      mkdirSync(firestoreDir, { recursive: true });
      writeFileSync(join(firestoreDir, 'captured-staged.json'), '{"name":"captured-staged"}');

      const loaded: LoadedModularProbe[] = [
        {
          id: 'linked-probe',
          surfaceDir: 'firestore',
          probe: {
            rig: 'sdk-probes',
            description: 'linked',
            matrixRow: 'firestore#1',
            rowIds: ['firestore#1'],
            observe: async () => ({ ok: true }),
          },
        },
        {
          id: 'captured-staged',
          surfaceDir: 'firestore',
          probe: {
            rig: 'sdk-probes',
            pendingRowLink: true,
            description: 'captured staged',
            matrixRow: '',
            rowIds: [],
            observe: async () => ({ ok: true }),
          },
        },
        {
          id: 'uncaptured-staged',
          surfaceDir: 'firestore',
          probe: {
            rig: 'sdk-probes',
            pendingRowLink: true,
            description: 'uncaptured staged',
            matrixRow: '',
            rowIds: [],
            observe: async () => ({ ok: true }),
          },
        },
      ];

      expect(selectModularProbes(loaded, [], 'sdk-probes').map((p) => p.id)).toEqual([
        'linked-probe',
        'captured-staged',
        'uncaptured-staged',
      ]);
      expect(
        selectModularProbes(loaded, ['--write'], 'sdk-probes', {
          observationsRoot: dir,
          includeUncapturedStaged: false,
        }).map((p) => p.id),
      ).toEqual(['linked-probe', 'captured-staged']);
      expect(
        selectModularProbes(loaded, ['--write', '--probe', 'uncaptured-staged'], 'sdk-probes', {
          observationsRoot: dir,
          includeUncapturedStaged: false,
        }).map((p) => p.id),
      ).toEqual(['uncaptured-staged']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('admin-firestore and storage-admin --write preserve committed linkage and auto-discover bucket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-admin-recapture-'));
    try {
      const fsObsPath = join(dir, 'admin-firestore-document-snapshot-get.json');
      writeFileSync(
        fsObsPath,
        JSON.stringify({
          name: 'admin-firestore-document-snapshot-get',
          matrixRow: '',
          rowIds: ['firestore-admin#5'],
          description: 'fs get',
          observedAt: '2026-07-21T00:00:00.000Z',
          adminSdkVersion: '13.10.0',
          behavior: { old: true },
        }),
      );
      await writeAdminFirestoreObservation(
        {
          description: 'fs get',
          matrixRow: '',
          rowIds: [],
          observe: async () => ({ fresh: true }),
        },
        '13.10.0',
        fsObsPath,
      );
      const writtenFs = JSON.parse(readFileSync(fsObsPath, 'utf8'));
      expect(writtenFs.rowIds).toEqual(['firestore-admin#5']);
      expect(writtenFs.behavior).toEqual({ fresh: true });

      const stObsPath = join(dir, 'admin-storage-metadata-download-url.json');
      writeFileSync(
        stObsPath,
        JSON.stringify({
          name: 'admin-storage-metadata-download-url',
          matrixRow: 'storage-admin #1',
          rowIds: ['storage-admin#1', 'storage#51'],
          description: 'storage meta',
          observedAt: '2026-09-24T00:00:00.000Z',
          adminSdkVersion: '13.10.0',
          behavior: { old: true },
        }),
      );
      await writeStorageAdminObservation(
        {
          description: 'storage meta',
          matrixRow: '',
          rowIds: [],
          observe: async () => ({ fresh: true }),
        },
        '13.10.0',
        stObsPath,
      );
      const writtenSt = JSON.parse(readFileSync(stObsPath, 'utf8'));
      expect(writtenSt.matrixRow).toBe('storage-admin #1');
      expect(writtenSt.rowIds).toEqual(['storage-admin#1', 'storage#51']);

      expect(
        await resolveAdminStorageBucket(
          {
            kind: 'application-default',
            project_id: 'example-proj',
            client_email: 'sa@example-proj.iam.gserviceaccount.com',
            credential: { getAccessToken: async () => ({ access_token: 'tok', expires_in: 3600 }) },
          },
          { PYRIC_ORACLE_STORAGE_BUCKET: 'gs://explicit-bucket/' },
        ),
      ).toBe('explicit-bucket');

      expect(
        await resolveAdminStorageBucket(
          {
            kind: 'application-default',
            project_id: 'example-proj',
            client_email: 'sa@example-proj.iam.gserviceaccount.com',
            credential: { getAccessToken: async () => ({ access_token: 'tok', expires_in: 3600 }) },
          },
          {
            PYRIC_ORACLE_FIREBASE_CONFIG: JSON.stringify({
              apiKey: 'k',
              authDomain: 'example-proj.firebaseapp.com',
              projectId: 'example-proj',
              storageBucket: 'discovered-bucket.firebasestorage.app',
            }),
          },
        ),
      ).toBe('discovered-bucket.firebasestorage.app');

      const rtdbProbe = createAdminQueryIndexProbe({
        config: {
          apiKey: 'k',
          authDomain: 'example-proj.firebaseapp.com',
          projectId: 'example-proj',
          databaseURL: 'https://example-proj-oracle.firebaseio.com',
        },
        rtdbAdminToken: 'tok',
        runId: 'test',
      });
      expect(rtdbProbe.rowIds).toEqual(['rtdb-modular#144', 'rtdb-admin#5']);
      expect(storageAdminRig.safety.unattendedSafe).toBe(true);
      expect(adminFirestoreRig.safety.unattendedSafe).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
