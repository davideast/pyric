import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Probe } from '../../rigs/types.ts';
import {
  observationLinkageOf,
  readObservationLinkage,
  resolveProbeObservationLinkage,
  shouldIncludeProbeInUnfilteredRun,
} from '../../src/observation-linkage.ts';
import { writeAdminAppObservations } from '../../src/admin-app-probes.ts';
import { writeAppRegistryObservations } from '../../src/app-registry-probes.ts';

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
});
