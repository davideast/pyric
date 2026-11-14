import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bytes, GeoPoint, Timestamp, doc, getAdminFirestore, getDoc } from 'pyric/firestore';
import { getAdminDatabase, get as databaseGet, ref as databaseRef, set as databaseSet } from 'pyric/database';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { applyData, type SandboxSeed } from '../../src/bridge/surface/seed-apply.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { runSeedFromLive } from '../../src/cli/seed-from-live.js';
import { createSandboxSession } from '../../src/serve/sandbox-session.js';
import { applyServeInit } from '../../src/serve/worker/serve-init.js';
import type { HostCtx } from '../../src/serve/worker/host.js';
import { LIVE_SEED_SANDBOX_PATH, LIVE_SESSION_DATA_PATH } from '../../src/serve/observed-session/wire.js';

describe('runSeedFromLive', () => {
  it('refuses to seed .pyric/state/hosted when neither --confirm nor --out is provided (including --confirm false)', async () => {
    let stderr = '';
    const code = await runSeedFromLive(parseArgs(['sandbox', 'seed-from-live']), {
      stderr: { write: (s) => { stderr += s; } },
      stdout: { write: () => {} },
    });
    expect(code).toBe(1);
    expect(stderr).toContain('--confirm');

    let stderrFalse = '';
    const codeFalse = await runSeedFromLive(parseArgs(['sandbox', 'seed-from-live', '--confirm', 'false']), {
      stderr: { write: (s) => { stderrFalse += s; } },
      stdout: { write: () => {} },
    });
    expect(codeFalse).toBe(1);
    expect(stderrFalse).toContain('--confirm');
  });

  it('rejects --mode in any form and names --replace, before looking for a host', async () => {
    for (const args of [['--mode', 'replace'], ['--mode=merge'], ['--mode', 'bogus']]) {
      let stderr = '';
      let discovered = false;
      const code = await runSeedFromLive(parseArgs(['sandbox', 'seed-from-live', '--confirm', ...args]), {
        discover: async () => { discovered = true; return null; },
        stderr: { write: (s) => { stderr += s; } },
        stdout: { write: () => {} },
      });
      expect(code).toBe(1);
      expect(stderr).toContain('--replace');
      expect(discovered).toBe(false);
    }
  });

  it('rejects a non-boolean --replace value', async () => {
    let stderr = '';
    const code = await runSeedFromLive(parseArgs(['sandbox', 'seed-from-live', '--confirm', '--replace', 'merge']), {
      discover: async () => null,
      stderr: { write: (s) => { stderr += s; } },
      stdout: { write: () => {} },
    });
    expect(code).toBe(1);
    expect(stderr).toContain('--replace');
  });

  it('merges by default and replaces only with --replace', async () => {
    const host = {
      url: 'http://localhost:4111',
      base: 'http://127.0.0.1:4111',
      mcpUrl: 'http://127.0.0.1:4111/__pyric/mcp',
      instanceId: 'inst-1',
      source: 'pointer',
    };
    const postedModes: unknown[] = [];
    const fetchMock = (async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { mode: unknown };
      postedModes.push(body.mode);
      return new Response(
        JSON.stringify({ ok: true, mode: body.mode, seededFirestoreDocs: 0, seededRtdbInstances: [] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    for (const args of [[], ['--replace'], ['--replace', 'false']]) {
      const code = await runSeedFromLive(parseArgs(['sandbox', 'seed-from-live', '--confirm', ...args, '--json']), {
        cwd: tmpdir(),
        discover: async () => host,
        fetchImpl: fetchMock,
        stderr: { write: () => {} },
        stdout: { write: () => {} },
      });
      expect(code).toBe(0);
    }
    expect(postedModes).toEqual(['merge', 'replace', 'merge']);
  });

  it('exports portable seed JSON via --out, refuses overwriting without --force, and posts confirmed seed requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-seed-cli-'));
    try {
      const outPath = join(dir, 'observed-seed.json');
      const snapshotPayload = {
        revision: 3,
        updatedAt: 100,
        projectId: 'demo-live',
        firestore: { 'users/ada': { name: 'Ada' } },
        rtdb: { 'demo-live-default-rtdb': { flags: { live: true } } },
        defaultRtdbInstance: 'demo-live-default-rtdb',
        stats: { firestoreDocs: 1, rtdbInstances: 1, byteEstimate: 64, truncated: false, droppedCount: 0 },
      };

      const discoveredHost = {
        url: 'http://localhost:4111',
        base: 'http://127.0.0.1:4111',
        mcpUrl: 'http://127.0.0.1:4111/__pyric/mcp',
        instanceId: 'inst-1',
        source: 'pointer',
      };

      let stdout = '';
      let stderr = '';
      let postedBody: Record<string, unknown> | null = null;
      const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(LIVE_SESSION_DATA_PATH)) {
          return new Response(JSON.stringify(snapshotPayload), { status: 200 });
        }
        if (url.endsWith(LIVE_SEED_SANDBOX_PATH)) {
          postedBody = JSON.parse(String(init?.body ?? '{}'));
          return new Response(
            JSON.stringify({
              ok: true,
              mode: postedBody?.mode ?? 'merge',
              seededFirestoreDocs: 1,
              seededRtdbInstances: ['demo-live-default-rtdb'],
              revision: 3,
            }),
            { status: 200 },
          );
        }
        return new Response('not found', { status: 404 });
      };

      const code1 = await runSeedFromLive(
        parseArgs(['sandbox', 'seed-from-live', '--out', outPath, '--json']),
        {
          cwd: dir,
          discover: async () => discoveredHost,
          fetchImpl: fetchMock as typeof fetch,
          stdout: { write: (s) => { stdout += s; } },
          stderr: { write: (s) => { stderr += s; } },
        },
      );
      expect(code1).toBe(0);
      // One instance was observed and exported, so the only warning is the file's place outside .pyric/.
      expect(stderr).toContain('holds observed production data inside the project');
      expect(stderr).not.toContain('not exported');
      stderr = '';
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        firestoreDocs: 1,
        rtdbInstance: 'demo-live-default-rtdb',
        revision: 3,
      });
      expect(JSON.parse(readFileSync(outPath, 'utf8'))).toEqual({
        firestore: { 'users/ada': { name: 'Ada' } },
        database: { flags: { live: true } },
      });

      // Second export without --force refuses overwrite with runtime exit code 2.
      const code2 = await runSeedFromLive(
        parseArgs(['sandbox', 'seed-from-live', '--out', outPath]),
        {
          cwd: dir,
          discover: async () => discoveredHost,
          fetchImpl: fetchMock as typeof fetch,
          stdout: { write: () => {} },
          stderr: { write: (s) => { stderr += s; } },
        },
      );
      expect(code2).toBe(2);
      expect(stderr).toContain('--force');

      // Confirmed CLI invocation with --replace posts confirm:true + mode:replace to /__pyric/live/seed-sandbox.
      let seedOut = '';
      const code3 = await runSeedFromLive(
        parseArgs(['sandbox', 'seed-from-live', '--confirm', '--replace', '--json']),
        {
          cwd: dir,
          discover: async () => discoveredHost,
          fetchImpl: fetchMock as typeof fetch,
          stdout: { write: (s) => { seedOut += s; } },
          stderr: { write: () => {} },
        },
      );
      expect(code3).toBe(0);
      expect(postedBody).toMatchObject({
        confirm: true,
        mode: 'replace',
        instanceId: 'inst-1',
      });
      expect(JSON.parse(seedOut)).toMatchObject({
        ok: true,
        mode: 'replace',
        seededFirestoreDocs: 1,
      });
      expect(LIVE_SEED_SANDBOX_PATH).toBe('/__pyric/live/seed-sandbox');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runSeedFromLive --out with several RTDB instances', () => {
  const discoveredHost = {
    url: 'http://localhost:4111',
    base: 'http://127.0.0.1:4111',
    mcpUrl: 'http://127.0.0.1:4111/__pyric/mcp',
    instanceId: 'inst-1',
    source: 'pointer',
  };
  const snapshotPayload = {
    revision: 4,
    updatedAt: 100,
    projectId: 'demo-live',
    firestore: {},
    rtdb: {
      'demo-live-default-rtdb': { items: { a: 1 } },
      'demo-live-second': { rooms: { r1: true } },
      'demo-live-third': { rooms: { r2: true } },
    },
    defaultRtdbInstance: 'demo-live-default-rtdb',
    stats: { firestoreDocs: 0, rtdbInstances: 3, byteEstimate: 64, truncated: false, droppedCount: 0 },
  };
  const fetchMock = (async () => new Response(JSON.stringify(snapshotPayload), { status: 200 })) as unknown as typeof fetch;

  async function exportTo(dir: string, args: string[]) {
    let stdout = '';
    let stderr = '';
    const code = await runSeedFromLive(parseArgs(['sandbox', 'seed-from-live', ...args]), {
      cwd: dir,
      discover: async () => discoveredHost,
      fetchImpl: fetchMock,
      stdout: { write: (s) => { stdout += s; } },
      stderr: { write: (s) => { stderr += s; } },
    });
    return { code, stdout, stderr };
  }

  it('names every observed instance a seed file leaves out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-seed-out-'));
    try {
      const run = await exportTo(dir, ['--out', '.pyric/seed.json']);
      expect(run.code).toBe(0);
      expect(run.stderr).toContain('not exported: demo-live-second, demo-live-third');
      expect(JSON.parse(readFileSync(join(dir, '.pyric/seed.json'), 'utf8'))).toEqual({ firestore: {}, database: { items: { a: 1 } } });

      const named = await exportTo(dir, ['--out', '.pyric/second.json', '--instance', 'demo-live-second', '--json']);
      expect(named.code).toBe(0);
      expect(JSON.parse(named.stdout)).toMatchObject({ rtdbInstance: 'demo-live-second', notExported: ['demo-live-default-rtdb', 'demo-live-third'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns when the file is inside the project but outside .pyric/', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-seed-out-'));
    try {
      const run = await exportTo(dir, ['--out', 'seed.json']);
      expect(run.code).toBe(0);
      expect(run.stderr).toContain('holds observed production data inside the project');
      const ignored = await exportTo(dir, ['--out', '.pyric/seed.json']);
      expect(ignored.stderr).not.toContain('inside the project');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips special Firestore types, escaped plain maps, and RTDB data through sandbox --seed and applyData', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-seed-roundtrip-'));
    mkdirSync(join(dir, 'sdk'));
    try {
      const typedSnapshot = {
        revision: 9,
        updatedAt: 900,
        projectId: 'demo-live',
        firestore: {
          'docs/d1': {
            ts: { seconds: 1700000000, nanoseconds: 125000000 },
            loc: { latitude: 37.7749, longitude: -122.4194 },
            bin: { type: 'firestore/bytes/1.0', bytes: 'AQID' },
            vec: { __type__: '__vector__', value: [0.5, 1.5] },
            ref: { type: 'document', path: 'orgs/o1', id: 'o1' },
            coordsMap: { type: 'pyric/map/1.0', fields: { latitude: 12.5, longitude: 42.25 } },
            spanMap: { type: 'pyric/map/1.0', fields: { seconds: 30, nanoseconds: 0 } },
            linkMap: { type: 'pyric/map/1.0', fields: { type: 'document', path: 'orgs/o1', id: 'o1' } },
            negZero: { type: 'pyric/number/1.0', value: '-0' },
            nanVal: { type: 'pyric/number/1.0', value: 'NaN' },
            posInf: { type: 'pyric/number/1.0', value: 'Infinity' },
            negInf: { type: 'pyric/number/1.0', value: '-Infinity' },
            numMap: { type: 'pyric/map/1.0', fields: { type: 'pyric/number/1.0', value: '-0' } },
          },
        },
        rtdb: {
          'demo-live-default-rtdb': { flags: { enabled: true }, count: 3 },
        },
        defaultRtdbInstance: 'demo-live-default-rtdb',
        stats: { firestoreDocs: 1, rtdbInstances: 1, byteEstimate: 256, truncated: false, droppedCount: 0 },
      };

      const seedRelPath = '.pyric/roundtrip-seed.json';
      const code = await runSeedFromLive(parseArgs(['sandbox', 'seed-from-live', '--out', seedRelPath]), {
        cwd: dir,
        discover: async () => discoveredHost,
        fetchImpl: (async () => new Response(JSON.stringify(typedSnapshot), { status: 200 })) as unknown as typeof fetch,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      });
      expect(code).toBe(0);

      const exported = JSON.parse(readFileSync(join(dir, seedRelPath), 'utf8')) as SandboxSeed;

      // 1. Round-trip through applyData (sandbox.seed)
      const directSandbox = createSandboxRoot();
      await applyData(directSandbox, exported);
      const directDb = getAdminFirestore(directSandbox);
      const directSnap = await getDoc(doc(directDb, 'docs/d1'));
      let directExists = directSnap.exists;
      if (typeof directExists === 'function') directExists = directExists.call(directSnap);
      expect(directExists).toBe(true);
      const directData = directSnap.data()!;
      expect(directData.ts).toBeInstanceOf(Timestamp);
      expect(directData.loc).toBeInstanceOf(GeoPoint);
      expect(directData.bin).toBeInstanceOf(Bytes);
      expect((directData.vec as { toArray: () => number[] }).toArray()).toEqual([0.5, 1.5]);
      expect((directData.ref as ReturnType<typeof doc>).path).toBe('orgs/o1');
      expect(directData.coordsMap).not.toBeInstanceOf(GeoPoint);
      expect(directData.coordsMap).toEqual({ latitude: 12.5, longitude: 42.25 });
      expect(directData.spanMap).not.toBeInstanceOf(Timestamp);
      expect(directData.spanMap).toEqual({ seconds: 30, nanoseconds: 0 });
      expect(directData.linkMap).toEqual({ type: 'document', path: 'orgs/o1', id: 'o1' });
      expect(Object.is(directData.negZero, -0)).toBe(true);
      expect(Number.isNaN(directData.nanVal)).toBe(true);
      expect(directData.posInf).toBe(Number.POSITIVE_INFINITY);
      expect(directData.negInf).toBe(Number.NEGATIVE_INFINITY);
      expect(directData.numMap).toEqual({ type: 'pyric/number/1.0', value: '-0' });
      expect((await databaseGet(databaseRef(getAdminDatabase(directSandbox), '/flags/enabled'))).val()).toBe(true);

      // 2. Round-trip through createSandboxSession + applyServeInit (pyric sandbox --seed <FILE>)
      writeFileSync(join(dir, 'firebase.json'), JSON.stringify({}));
      const session = await createSandboxSession({
        projectDir: dir,
        firebaseConfig: null,
        sdk: { dir: join(dir, 'sdk') },
        seedFile: seedRelPath,
      });
      try {
        const initSandbox = createSandboxRoot();
        const initCtx: HostCtx = {
          sandbox: initSandbox,
          db: getAdminFirestore(initSandbox),
          subs: new Map(),
          instanceId: 'seed-init-roundtrip',
        };
        const initRes = applyServeInit(initCtx, session.payload());
        expect(initRes.seededDocs).toBe(1);
        const initDoc = await getDoc(doc(initCtx.db, 'docs/d1'));
        let initExists = initDoc.exists;
        if (typeof initExists === 'function') initExists = initExists.call(initDoc);
        expect(initExists).toBe(true);
        const initData = initDoc.data()!;
        expect(initData.ts).toBeInstanceOf(Timestamp);
        expect(initData.loc).toBeInstanceOf(GeoPoint);
        expect((initData.ref as ReturnType<typeof doc>).path).toBe('orgs/o1');
        expect(initData.coordsMap).not.toBeInstanceOf(GeoPoint);
        expect(initData.coordsMap).toEqual({ latitude: 12.5, longitude: 42.25 });
        expect((await databaseGet(databaseRef(getAdminDatabase(initSandbox), '/count'))).val()).toBe(3);
      } finally {
        await session.close();
      }

      // 3. Round-trip through persisted createSandboxSession (pyric sandbox --seed <FILE> with persistence)
      const persistedSession = await createSandboxSession({
        projectDir: dir,
        firebaseConfig: null,
        sdk: { dir: join(dir, 'sdk') },
        seedFile: seedRelPath,
        persistence: { fresh: true },
      });
      try {
        expect(persistedSession.summary.persistence).toMatchObject({
          restoredDocs: 1,
        });
      } finally {
        await persistedSession.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exports array and scalar RTDB roots via --out while omitting null roots, and round-trips them through --seed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-seed-nonobj-rtdb-'));
    mkdirSync(join(dir, 'sdk'));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({}));
    try {
      const cases: Array<{ name: string; value: unknown }> = [
        { name: 'array-root', value: ['item-a', 'item-b'] },
        { name: 'string-root', value: 'maintenance' },
        { name: 'number-root', value: 0 },
        { name: 'boolean-root', value: false },
      ];

      for (const testCase of cases) {
        const snap = {
          revision: 11,
          updatedAt: 950,
          projectId: 'demo-live',
          firestore: { 'items/i1': { title: 'One' } },
          rtdb: {
            'demo-live-default-rtdb': testCase.value,
          },
          defaultRtdbInstance: 'demo-live-default-rtdb',
          stats: { firestoreDocs: 1, rtdbInstances: 1, byteEstimate: 64, truncated: false, droppedCount: 0 },
        };
        const seedRelPath = `.pyric/${testCase.name}.json`;
        let stdout = '';
        let stderr = '';
        const code = await runSeedFromLive(
          parseArgs(['sandbox', 'seed-from-live', '--out', seedRelPath, '--instance', 'demo-live-default-rtdb', '--force', '--json']),
          {
            cwd: dir,
            discover: async () => discoveredHost,
            fetchImpl: (async () => new Response(JSON.stringify(snap), { status: 200 })) as unknown as typeof fetch,
            stdout: { write: (s) => { stdout += s; } },
            stderr: { write: (s) => { stderr += s; } },
          },
        );
        expect(code).toBe(0);
        expect(stderr).toBe('');
        expect(JSON.parse(stdout)).toMatchObject({
          ok: true,
          rtdbInstance: 'demo-live-default-rtdb',
          notExported: [],
        });

        const exported = JSON.parse(readFileSync(join(dir, seedRelPath), 'utf8')) as SandboxSeed;
        expect(exported.database as unknown).toEqual(testCase.value);

        const directSandbox = createSandboxRoot();
        await applyData(directSandbox, exported);
        expect((await databaseGet(databaseRef(getAdminDatabase(directSandbox), '/'))).val() as unknown).toEqual(testCase.value);

        const session = await createSandboxSession({
          projectDir: dir,
          firebaseConfig: null,
          sdk: { dir: join(dir, 'sdk') },
          seedFile: seedRelPath,
        });
        try {
          const initSandbox = createSandboxRoot();
          const initCtx: HostCtx = {
            sandbox: initSandbox,
            db: getAdminFirestore(initSandbox),
            subs: new Map(),
            instanceId: `seed-init-${testCase.name}`,
          };
          applyServeInit(initCtx, session.payload());
          expect((await databaseGet(databaseRef(getAdminDatabase(initSandbox), '/'))).val() as unknown).toEqual(testCase.value);

          // Reload (`persist: true`) when sandbox already holds RTDB-only state must skip re-seeding rather than overwriting.
          const reloadSandbox = createSandboxRoot();
          await databaseSet(databaseRef(getAdminDatabase(reloadSandbox), '/'), { preservedCounter: 99 });
          const reloadCtx: HostCtx = {
            sandbox: reloadSandbox,
            db: getAdminFirestore(reloadSandbox),
            subs: new Map(),
            instanceId: `seed-reload-rtdb-${testCase.name}`,
          };
          const emptyFsSeedPayload = {
            ...session.payload(),
            persist: true,
            seed: { firestore: {}, database: testCase.value },
          };
          const reloadRes = applyServeInit(reloadCtx, emptyFsSeedPayload);
          expect(reloadRes.seedSkipped).toBe('existing-data');
          expect((await databaseGet(databaseRef(getAdminDatabase(reloadSandbox), '/'))).val() as unknown).toEqual({
            preservedCounter: 99,
          });
        } finally {
          await session.close();
        }
      }

      // Null/unobserved RTDB roots stay omitted from --out.
      const nullSnap = {
        revision: 12,
        updatedAt: 960,
        projectId: 'demo-live',
        firestore: {},
        rtdb: { 'demo-live-default-rtdb': null },
        defaultRtdbInstance: 'demo-live-default-rtdb',
        stats: { firestoreDocs: 0, rtdbInstances: 0, byteEstimate: 0, truncated: false, droppedCount: 0 },
      };
      let nullStdout = '';
      const nullCode = await runSeedFromLive(
        parseArgs(['sandbox', 'seed-from-live', '--out', '.pyric/null-root.json', '--force', '--json']),
        {
          cwd: dir,
          discover: async () => discoveredHost,
          fetchImpl: (async () => new Response(JSON.stringify(nullSnap), { status: 200 })) as unknown as typeof fetch,
          stdout: { write: (s) => { nullStdout += s; } },
          stderr: { write: () => {} },
        },
      );
      expect(nullCode).toBe(0);
      expect(JSON.parse(nullStdout)).toMatchObject({ rtdbInstance: null });
      const nullSeed = JSON.parse(readFileSync(join(dir, '.pyric/null-root.json'), 'utf8')) as Record<string, unknown>;
      expect('database' in nullSeed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
