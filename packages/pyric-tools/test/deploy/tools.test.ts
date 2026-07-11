/**
 * Smoke tests for the Slice 9 factories.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fixture modules must resolve `pyric/rules/rtdb` via workspace
// node_modules, so they're created under this test directory (inside
// the monorepo tree) rather than the OS tmpdir.
const fixturesRoot = fileURLToPath(new URL('./fixtures-tmp/', import.meta.url));
import { createToolRegistry, createDispatch } from '@inbrowser/agent';
import {
  createFirestoreDeployTools,
  createRtdbDeployTools,
  createHostingDeployTools,
  createFunctionsDeployTools,
  type ProjectScope,
} from '../../src/deploy/index.js';

const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = originalFetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

const scope: ProjectScope = { projectId: 'p', resolveToken: async () => 'TKN' };
const ctx = { signal: new AbortController().signal };

function installMock(responses: Response[]): void {
  const queue = [...responses];
  globalThis.fetch = (async () => {
    const next = queue.shift();
    if (!next) throw new Error('mock empty');
    return next;
  }) as typeof fetch;
}

describe('createFirestoreDeployTools', () => {
  const tools = createFirestoreDeployTools({ scope });

  it('emits the full firestore deploy tool set', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'firestore_create_index',
      'firestore_deploy_indexes',
      'firestore_deploy_rules',
      'firestore_ensure_rules',
      'firestore_get_index_status',
      'firestore_get_rules',
      'firestore_provision_database',
    ]);
  });

  it('firestore_get_rules dispatches via registry', async () => {
    const registry = createToolRegistry();
    for (const t of tools) registry.register(t);
    const dispatch = createDispatch(registry);
    installMock([new Response('not found', { status: 404 })]);
    const result = await dispatch.execute({ id: '1', name: 'firestore_get_rules', args: {} }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('No deployed');
  });
});

describe('createHostingDeployTools', () => {
  const tools = createHostingDeployTools({ scope });

  it('emits hosting tool set', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'hosting_deploy',
      'hosting_ensure_site',
    ]);
  });
});

describe('createRtdbDeployTools', () => {
  const tools = createRtdbDeployTools({ scope });

  it('emits RTDB deploy tool set', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'rtdb_deploy_rules',
      'rtdb_generate_rules',
      'rtdb_get_rules',
    ]);
  });

  it('deploys explicit database rules without discovery', async () => {
    installMock([new Response('{}', { status: 200 })]);
    const tool = tools.find((t) => t.name === 'rtdb_deploy_rules');
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      {
        databaseUrl: 'https://p-default-rtdb.firebaseio.com',
        rulesJson: { rules: { '.read': false, '.write': false } },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  describe('rtdb_generate_rules', () => {
    let dir: string | undefined;

    afterAll(() => {
      rmSync(fixturesRoot, { recursive: true, force: true });
    });

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it('compiles a constraints module via toJSON() and returns the same JSON', async () => {
      mkdirSync(fixturesRoot, { recursive: true });
      dir = mkdtempSync(join(fixturesRoot, 'gen-'));
      writeFileSync(
        join(dir, 'database.rules.ts'),
        [
          "import { allow, defineRtdbRules, deny } from 'pyric/rules/rtdb';",
          'export const rules = defineRtdbRules({',
          "  paths: { '/': { read: allow(), write: deny() } },",
          '});',
        ].join('\n'),
      );

      const tool = tools.find((t) => t.name === 'rtdb_generate_rules');
      expect(tool).toBeDefined();
      const result = await tool!.execute({ configPath: 'database.rules.ts', cwd: dir }, ctx);

      expect(result.ok).toBe(true);
      const { defineRtdbRules, allow, deny } = await import('pyric/rules/rtdb');
      const expected = defineRtdbRules({
        paths: { '/': { read: allow(), write: deny() } },
      }).toJSON();
      expect((result.data as { rulesJson: unknown }).rulesJson).toEqual(expected);
    });

    it('fails gracefully when no constraints module is found', async () => {
      mkdirSync(fixturesRoot, { recursive: true });
      dir = mkdtempSync(join(fixturesRoot, 'gen-'));
      const tool = tools.find((t) => t.name === 'rtdb_generate_rules');
      const result = await tool!.execute({ configPath: 'missing.ts', cwd: dir }, ctx);
      expect(result.ok).toBe(false);
    });
  });
});

describe('createFunctionsDeployTools', () => {
  const tools = createFunctionsDeployTools({ scope });

  it('emits functions tool set', () => {
    expect(tools.map((t) => t.name)).toEqual(['functions_deploy']);
  });
});

describe('cross-factory composition', () => {
  it('full Deployment Agent registry assembles cleanly (smoke)', () => {
    const registry = createToolRegistry();
    for (const t of createFirestoreDeployTools({ scope })) registry.register(t);
    for (const t of createRtdbDeployTools({ scope })) registry.register(t);
    for (const t of createHostingDeployTools({ scope })) registry.register(t);
    for (const t of createFunctionsDeployTools({ scope })) registry.register(t);
    const names = registry.list().map((h) => h.name);
    expect(names.length).toBe(13);
    // No duplicate names — register would have thrown.
    expect(new Set(names).size).toBe(names.length);
  });
});
