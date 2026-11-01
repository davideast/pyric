/**
 * The context a record gets wherever the sandbox lives: the forwarded tool
 * families under the held identity, the host's RTDB instances, and nothing
 * that exists only in the bridge process.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';

import { UnknownToolError } from '../../../src/bridge/client/dispatch.js';
import { databaseInstanceCatalog } from '../../../src/bridge/surface/database-instance-catalog.js';
import {
  callSandboxTool,
  createSandboxSurfaceContext,
  operationFailure,
} from '../../../src/bridge/surface/sandbox-context.js';

const catalog = databaseInstanceCatalog({ defaultInstance: 'demo-default-rtdb', named: ['side'], pending: [] });

function sandboxContext() {
  return createSandboxSurfaceContext(initializeSandbox(), async () => catalog);
}

describe('createSandboxSurfaceContext', () => {
  it('runs a forwarded tool family against its own sandbox', async () => {
    const ctx = sandboxContext();
    const written = await callSandboxTool(ctx, 'firestore_create_document', {
      path: 'notes/n1',
      data: { title: 'hello' },
    });
    expect(written.ok).toBe(true);
    const read = await callSandboxTool(ctx, 'firestore_get_document', { path: 'notes/n1' });
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read.data)).toContain('hello');
  });

  it('does not reach an in-process tool family', async () => {
    const ctx = sandboxContext();
    await expect(callSandboxTool(ctx, 'rules_stdlib_list', {})).rejects.toBeInstanceOf(UnknownToolError);
  });

  it('answers the RTDB instances from the catalog it was given', async () => {
    const ctx = sandboxContext();
    expect((await ctx.databaseInstances()).select('side')).toBe('side');
  });

  it('carries no project directory', () => {
    expect('projectDir' in sandboxContext()).toBe(false);
  });
});

describe('operationFailure', () => {
  it('reports a failure with or without data', () => {
    expect(operationFailure('no')).toEqual({ ok: false, summary: 'no' });
    expect(operationFailure('no', { why: 1 })).toEqual({ ok: false, summary: 'no', data: { why: 1 } });
  });
});
