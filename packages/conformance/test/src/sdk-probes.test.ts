import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeObservation } from '../../../../scripts/ci/oracle-observation-diff.ts';
import {
  executeModularProbes,
  loadModularProbes,
  printModularProbePreview,
  SDK_PROBES_RIG_CONFIG,
  selectModularProbes,
  validateModularProbeRequirements,
} from '../../src/sdk-probes.ts';
import { ADMIN_AUTH_RIG_CONFIG, runAdminAuthProbesCli } from '../../src/admin-auth-probes.ts';
import {
  buildLazyRtdbRunProbes,
  printRunInertPreview,
  selectFilteredRunProbes,
  withGuardedProbeRtdbRules,
} from '../../src/oracle-run-rtdb-probes.ts';
import {
  withAdminAuthProbeSession,
  withFirestoreProbeSession,
  withRtdbProbeSession,
} from '../../src/sdk-probe-runtime.ts';
import { probe as limitToLastProbe } from '../../probes/firestore/firestore-limittolast-preconditions.ts';
import { probe as startAtProbe } from '../../probes/firestore/firestore-startat-snapshot-implicit-name.ts';
import { probe as updateDocDotpathProbe } from '../../probes/firestore/firestore-updatedoc-dotpath-fieldpath.ts';
import { rig as adminAuthRig } from '../../rigs/admin-auth.ts';
import { rig as firestoreRealRig } from '../../rigs/firestore-real.ts';
import { rig as firestoreWriteReqRig } from '../../rigs/firestore-write-request-resource.ts';
import { rig as sdkProbesRig } from '../../rigs/sdk-probes.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_TS_PATH = join(HERE, '..', '..', 'src', 'run.ts');
const COMMITTED_OBS_ROOT = join(HERE, '..', '..', 'observations');

describe('modular one-file-per-probe SDK runner (sdk-probes.ts)', () => {
  it('loads the 3 extracted Firestore probes under rig sdk-probes and removes them from run.ts', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const ids = loaded.map((item) => item.id);
    expect(ids).toContain('firestore-limittolast-preconditions');
    expect(ids).toContain('firestore-startat-snapshot-implicit-name');
    expect(ids).toContain('firestore-updatedoc-dotpath-fieldpath');

    for (const item of loaded) {
      expect(item.probe.rig).toBe('sdk-probes');
      expect(typeof item.probe.observe).toBe('function');
    }

    const runSource = readFileSync(RUN_TS_PATH, 'utf8');
    expect(runSource).not.toContain("name: 'firestore-limittolast-preconditions'");
    expect(runSource).not.toContain("name: 'firestore-startat-snapshot-implicit-name'");
    expect(runSource).not.toContain("name: 'firestore-updatedoc-dotpath-fieldpath'");

    expect(limitToLastProbe.rowIds).toEqual(['firestore#61']);
    expect(startAtProbe.rowIds).toEqual(['firestore#71']);
    expect(updateDocDotpathProbe.rowIds).toEqual(['firestore#33']);
    expect(sdkProbesRig.script).toBe('packages/conformance/src/sdk-probes.ts');
    expect(sdkProbesRig.probeDeclaredOwnership).toBe(true);
    expect(adminAuthRig.script).toBe('packages/conformance/src/admin-auth-probes.ts');
    expect(firestoreRealRig.safety.unattendedSafe).toBe(false);
    expect(firestoreWriteReqRig.safety.unattendedSafe).toBe(false);
    expect(typeof withFirestoreProbeSession).toBe('function');
    expect(typeof withRtdbProbeSession).toBe('function');
    expect(typeof withAdminAuthProbeSession).toBe('function');

    await runAdminAuthProbesCli([], {}, false);
    const rtdbProbes = await buildLazyRtdbRunProbes({
      runId: 'test',
      getLiveState: () => ({
        config: { apiKey: 'k', authDomain: 'd', projectId: 'p' },
        serviceAccount: null,
        rtdbAdminToken: null,
      }),
    });
    expect(rtdbProbes.length).toBeGreaterThan(0);
    const filtered = selectFilteredRunProbes(rtdbProbes, ['--write', rtdbProbes[0]?.name ?? '']);
    expect(filtered.selected.length).toBeGreaterThan(0);
    printRunInertPreview({
      fbSdkVersion: '12.19.0',
      totalCount: rtdbProbes.length,
      selected: [],
      filters: ['none'],
    });
    expect(typeof withGuardedProbeRtdbRules).toBe('function');
  });

  it('produces zero canonicalizeObservation drift against committed envelopes for all extracted Firestore probes', async () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'sdk-probes-canonical-'));
    try {
      const loaded = await loadModularProbes('sdk-probes');
      const extractedIds = new Set([
        'firestore-limittolast-preconditions',
        'firestore-startat-snapshot-implicit-name',
        'firestore-updatedoc-dotpath-fieldpath',
      ]);
      const extracted = loaded.filter((item) => extractedIds.has(item.id));
      expect(extracted).toHaveLength(3);

      for (const item of extracted) {
        const committedPath = join(COMMITTED_OBS_ROOT, item.surfaceDir, `${item.id}.json`);
        const committedRaw = readFileSync(committedPath, 'utf8');
        const committedJson = JSON.parse(committedRaw) as {
          fbSdkVersion: string;
          projectId: string;
          behavior: Record<string, unknown>;
        };

        await executeModularProbes({
          config: SDK_PROBES_RIG_CONFIG,
          sdkVersion: committedJson.fbSdkVersion,
          projectId: committedJson.projectId,
          observationsRoot: outRoot,
          probes: [
            {
              ...item,
              probe: {
                ...item.probe,
                observe: async () => committedJson.behavior,
              },
            },
          ],
        });

        const writtenRaw = readFileSync(join(outRoot, item.surfaceDir, `${item.id}.json`), 'utf8');
        expect(canonicalizeObservation(writtenRaw)).toBe(canonicalizeObservation(committedRaw));
      }
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  it('filters modular probes by --probe and rejects unknown probe selectors', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const one = selectModularProbes(loaded, ['--probe', 'firestore-limittolast-preconditions'], 'sdk-probes');
    expect(one.map((item) => item.id)).toEqual(['firestore-limittolast-preconditions']);

    const eqForm = selectModularProbes(
      loaded,
      ['--write', '--probe=firestore-updatedoc-dotpath-fieldpath'],
      'sdk-probes',
    );
    expect(eqForm.map((item) => item.id)).toEqual(['firestore-updatedoc-dotpath-fieldpath']);

    expect(() => selectModularProbes(loaded, ['--probe', 'unknown-probe'], 'sdk-probes')).toThrow(
      /unknown sdk-probes probe: unknown-probe/,
    );
  });

  it('prints a plain-ASCII inert preview without reading credentials or making network calls', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    const text = lines.join('\n');
    expect(text).toContain('INERT preview');
    expect(text).toContain('firestore-limittolast-preconditions');
    expect(text).toContain('--write');
    for (const ch of text) {
      expect(ch.codePointAt(0) ?? 0).toBeLessThanOrEqual(127);
    }
  });

  it('reports exact missing credentials, secrets, or dedicated RTDB URLs before running live probes', () => {
    expect(() =>
      validateModularProbeRequirements(
        [
          {
            id: 'admin-auth-sample',
            surfaceDir: 'auth-admin',
            probe: {
              rig: 'admin-auth',
              requires: ['admin-auth'],
              description: 'sample',
              matrixRow: '',
              rowIds: [],
              observe: async () => ({}),
            },
          },
        ],
        {},
      ),
    ).toThrow(/PYRIC_ORACLE_PROJECT_ID.*roles\/firebaseauth\.admin/);

    expect(() =>
      validateModularProbeRequirements(
        [
          {
            id: 'rtdb-modular-sample',
            surfaceDir: 'rtdb-modular',
            probe: {
              rig: 'sdk-probes',
              requires: ['web-config', 'dedicated-rtdb'],
              description: 'sample',
              matrixRow: '',
              rowIds: [],
              observe: async () => ({}),
            },
          },
        ],
        { PYRIC_ORACLE_PROJECT_ID: 'digame-mas' },
      ),
    ).toThrow(/PYRIC_ORACLE_FIREBASE_CONFIG/);

    expect(() =>
      validateModularProbeRequirements(
        [
          {
            id: 'rtdb-modular-sample',
            surfaceDir: 'rtdb-modular',
            probe: {
              rig: 'sdk-probes',
              requires: ['web-config', 'dedicated-rtdb'],
              description: 'sample',
              matrixRow: '',
              rowIds: [],
              observe: async () => ({}),
            },
          },
        ],
        {
          PYRIC_ORACLE_PROJECT_ID: 'digame-mas',
          PYRIC_ORACLE_FIREBASE_CONFIG: '{"apiKey":"k","authDomain":"d","projectId":"digame-mas"}',
        },
      ),
    ).toThrow(/PYRIC_ORACLE_RTDB_URL.*roles\/firebasedatabase\.admin/);
  });

  it('writes client fbSdkVersion and admin adminSdkVersion envelopes into matching surface directories', async () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'modular-sdk-probes-'));
    try {
      await executeModularProbes({
        config: SDK_PROBES_RIG_CONFIG,
        sdkVersion: '12.19.0',
        projectId: 'digame-mas',
        observationsRoot: outRoot,
        probes: [
          {
            id: 'firestore-sample-modular',
            surfaceDir: 'firestore',
            probe: {
              rig: 'sdk-probes',
              description: 'Sample Firestore modular probe.',
              matrixRow: 'firestore #1',
              rowIds: ['firestore#1'],
              observe: async () => ({ ok: true }),
            },
          },
        ],
      });

      await executeModularProbes({
        config: ADMIN_AUTH_RIG_CONFIG,
        sdkVersion: '13.7.0',
        projectId: 'digame-mas',
        observationsRoot: outRoot,
        probes: [
          {
            id: 'admin-auth-sample-modular',
            surfaceDir: 'auth-admin',
            probe: {
              rig: 'admin-auth',
              pendingRowLink: true,
              description: 'Sample Admin Auth modular probe.',
              matrixRow: '',
              rowIds: [],
              observe: async () => ({ cursorAdvanced: true }),
            },
          },
        ],
      });

      const fsObs = JSON.parse(
        readFileSync(join(outRoot, 'firestore', 'firestore-sample-modular.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(fsObs.name).toBe('firestore-sample-modular');
      expect(fsObs.fbSdkVersion).toBe('12.19.0');
      expect(fsObs.adminSdkVersion).toBeUndefined();
      expect(fsObs.projectId).toBe('digame-mas');
      expect(fsObs.behavior).toEqual({ ok: true });

      const authObs = JSON.parse(
        readFileSync(join(outRoot, 'auth-admin', 'admin-auth-sample-modular.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(authObs.name).toBe('admin-auth-sample-modular');
      expect(authObs.adminSdkVersion).toBe('13.7.0');
      expect(authObs.fbSdkVersion).toBeUndefined();
      expect(authObs.rowIds).toEqual([]);
      expect(authObs.behavior).toEqual({ cursorAdvanced: true });
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });
});
