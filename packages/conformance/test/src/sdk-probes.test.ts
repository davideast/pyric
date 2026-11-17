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
  resolveProbeWebConfig,
  withAdminAuthProbeSession,
  withFirestoreProbeSession,
  withRtdbProbeSession,
} from '../../src/sdk-probe-runtime.ts';
import type { OracleServiceAccount } from '../../src/oracle-credential.ts';
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
            id: 'firestore-modular-sample',
            surfaceDir: 'firestore',
            probe: {
              rig: 'sdk-probes',
              requires: ['web-config', 'firestore-rules'],
              description: 'sample',
              matrixRow: '',
              rowIds: [],
              observe: async () => ({}),
            },
          },
        ],
        { PYRIC_ORACLE_PROJECT_ID: 'example-oracle', PYRIC_ORACLE_FIREBASE_CONFIG: '' },
      ),
    ).not.toThrow();

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
        { PYRIC_ORACLE_PROJECT_ID: 'example-oracle' },
      ),
    ).toThrow(/PYRIC_ORACLE_RTDB_URL.*roles\/firebasedatabase\.admin/);

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
          PYRIC_ORACLE_PROJECT_ID: 'example-oracle',
          PYRIC_ORACLE_FIREBASE_CONFIG: '',
          PYRIC_ORACLE_RTDB_URL: 'https://example-oracle-rtdb-2.firebaseio.com',
        },
      ),
    ).not.toThrow();

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
          PYRIC_ORACLE_PROJECT_ID: 'example-oracle',
          PYRIC_ORACLE_FIREBASE_CONFIG: '{"apiKey":"k","authDomain":"d","projectId":"example-oracle"}',
        },
      ),
    ).toThrow(/PYRIC_ORACLE_RTDB_URL.*roles\/firebasedatabase\.admin/);

    expect(() =>
      validateModularProbeRequirements(
        [
          {
            id: 'firestore-modular-sample',
            surfaceDir: 'firestore',
            probe: {
              rig: 'sdk-probes',
              requires: ['web-config', 'firestore-rules'],
              description: 'sample',
              matrixRow: '',
              rowIds: [],
              observe: async () => ({}),
            },
          },
        ],
        {
          PYRIC_ORACLE_PROJECT_ID: 'example-oracle',
          PYRIC_ORACLE_FIREBASE_CONFIG: '{"apiKey":"k","authDomain":"d","projectId":"wrong-project"}',
        },
      ),
    ).toThrow(/wrong-project.*example-oracle/);
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

function makeFakeOracleAccount(
  projectId: string,
  onAccessToken: () => Promise<string>,
): OracleServiceAccount {
  return {
    kind: 'application-default',
    project_id: projectId,
    client_email: `probe-runner@${projectId}.iam.gserviceaccount.com`,
    credential: {
      async getAccessToken() {
        return {
          access_token: await onAccessToken(),
          expires_in: 3600,
        };
      },
    },
  };
}

describe('resolveProbeWebConfig (sdk-probe-runtime.ts)', () => {
  it('prefers explicit PYRIC_ORACLE_FIREBASE_CONFIG without hitting fetch or minting an OAuth token, and validates projectId', async () => {
    const sa = makeFakeOracleAccount('example-oracle', async () => {
      throw new Error('unexpected getAccessToken call when PYRIC_ORACLE_FIREBASE_CONFIG is set');
    });
    const neverFetch = async (): Promise<Response> => {
      throw new Error('unexpected fetch call when PYRIC_ORACLE_FIREBASE_CONFIG is set');
    };

    const explicitConfig = {
      apiKey: 'explicit-api-key',
      authDomain: 'example-oracle.firebaseapp.com',
      projectId: 'example-oracle',
      appId: '1:111111:web:explicit',
    };

    const resolved = await resolveProbeWebConfig(sa, {
      env: { PYRIC_ORACLE_FIREBASE_CONFIG: JSON.stringify(explicitConfig) },
      fetchImpl: neverFetch,
    });
    expect(resolved).toEqual(explicitConfig);

    await expect(
      resolveProbeWebConfig(sa, {
        env: {
          PYRIC_ORACLE_FIREBASE_CONFIG: JSON.stringify({
            ...explicitConfig,
            projectId: 'other-project',
          }),
        },
        fetchImpl: neverFetch,
      }),
    ).rejects.toThrow(/other-project.*example-oracle/);
  });

  it('discovers apps[0].appId and /config via Firebase Management API when PYRIC_ORACLE_FIREBASE_CONFIG is unset, and validates projectId', async () => {
    let tokenMints = 0;
    const sa = makeFakeOracleAccount('example-oracle', async () => {
      tokenMints += 1;
      return 'oauth-token-123';
    });

    const seenRequests: Array<{ url: string; auth: string | null; method: string }> = [];
    const discoveredConfig = {
      apiKey: 'discovered-api-key',
      authDomain: 'example-oracle.firebaseapp.com',
      projectId: 'example-oracle',
      appId: '1:987654:web:abc123',
      storageBucket: 'example-oracle.firebasestorage.app',
    };

    const fakeFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seenRequests.push({
        url,
        auth: headers.get('Authorization'),
        method: init?.method ?? 'GET',
      });
      if (url === 'https://firebase.googleapis.com/v1beta1/projects/example-oracle/webApps') {
        return new Response(
          JSON.stringify({
            apps: [
              { appId: '1:987654:web:abc123', displayName: 'Primary Web' },
              { appId: '1:987654:web:second', displayName: 'Second Web' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (
        url ===
        'https://firebase.googleapis.com/v1beta1/projects/example-oracle/webApps/1%3A987654%3Aweb%3Aabc123/config'
      ) {
        return new Response(JSON.stringify(discoveredConfig), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('unexpected endpoint', { status: 404 });
    };

    const resolved = await resolveProbeWebConfig(sa, {
      env: { PYRIC_ORACLE_FIREBASE_CONFIG: '' },
      fetchImpl: fakeFetch,
    });
    expect(resolved).toEqual(discoveredConfig);
    expect(tokenMints).toBe(1);
    expect(seenRequests).toEqual([
      {
        url: 'https://firebase.googleapis.com/v1beta1/projects/example-oracle/webApps',
        auth: 'Bearer oauth-token-123',
        method: 'GET',
      },
      {
        url: 'https://firebase.googleapis.com/v1beta1/projects/example-oracle/webApps/1%3A987654%3Aweb%3Aabc123/config',
        auth: 'Bearer oauth-token-123',
        method: 'GET',
      },
    ]);

    const mismatchedFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/webApps')) {
        return new Response(JSON.stringify({ apps: [{ appId: '1:987654:web:abc123' }] }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ ...discoveredConfig, projectId: 'foreign-project' }),
        { status: 200 },
      );
    };

    await expect(
      resolveProbeWebConfig(sa, { env: {}, fetchImpl: mismatchedFetch }),
    ).rejects.toThrow(/foreign-project.*example-oracle/);
  });

  it('throws clear diagnostic errors on empty apps: [] (never auto-creating Web Apps) and HTTP 403 failures', async () => {
    const sa = makeFakeOracleAccount('example-oracle', async () => 'oauth-token-123');

    const emptyCalls: Array<{ url: string; method: string }> = [];
    const emptyAppsFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      emptyCalls.push({ url: String(input), method: init?.method ?? 'GET' });
      return new Response(JSON.stringify({ apps: [] }), { status: 200 });
    };

    await expect(
      resolveProbeWebConfig(sa, { env: {}, fetchImpl: emptyAppsFetch }),
    ).rejects.toThrow(/no registered Firebase Web App.*refusing to auto-create/);
    expect(emptyCalls).toEqual([
      {
        url: 'https://firebase.googleapis.com/v1beta1/projects/example-oracle/webApps',
        method: 'GET',
      },
    ]);

    const forbiddenListFetch = async (): Promise<Response> => {
      return new Response(
        "Permission 'firebase.projects.get' denied on resource 'projects/example-oracle'.",
        { status: 403 },
      );
    };

    await expect(
      resolveProbeWebConfig(sa, { env: {}, fetchImpl: forbiddenListFetch }),
    ).rejects.toThrow(/HTTP 403.*firebase\.googleapis\.com.*roles\/firebase\.viewer.*firebase\.projects\.get/);

    const forbiddenConfigFetch = async (input: string | URL | Request): Promise<Response> => {
      if (String(input).endsWith('/webApps')) {
        return new Response(JSON.stringify({ apps: [{ appId: '1:987:web:abc' }] }), {
          status: 200,
        });
      }
      return new Response(
        "Permission 'firebase.clients.get' denied on resource 'projects/example-oracle/webApps/1:987:web:abc'.",
        { status: 403 },
      );
    };

    await expect(
      resolveProbeWebConfig(sa, { env: {}, fetchImpl: forbiddenConfigFetch }),
    ).rejects.toThrow(/HTTP 403.*firebase\.googleapis\.com.*roles\/firebase\.viewer.*firebase\.clients\.get/);
  });
});
