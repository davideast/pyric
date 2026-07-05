/**
 * Smoke tests for the Slice 9 factories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createToolRegistry, createDispatch } from '@inbrowser/agent';
import {
  createFirestoreDeployTools,
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
    for (const t of createHostingDeployTools({ scope })) registry.register(t);
    for (const t of createFunctionsDeployTools({ scope })) registry.register(t);
    const names = registry.list().map((h) => h.name);
    expect(names.length).toBe(10);
    // No duplicate names — register would have thrown.
    expect(new Set(names).size).toBe(names.length);
  });
});
