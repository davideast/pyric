import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/parse-args.js';
import { runSeedFromLive } from '../../src/cli/seed-from-live.js';
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
});
