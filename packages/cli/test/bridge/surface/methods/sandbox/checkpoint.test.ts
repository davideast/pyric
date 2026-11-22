import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';

import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../../../src/bridge/surface/index.js';

const surface = renderSurface(undefined);

describe('sandbox.checkpoint overwrite confirmation (#1919)', () => {
  let projectDir: string;
  let sandbox: LocalSandbox;
  let ctx: SurfaceContext;

  async function call(key: string, args: Record<string, unknown> = {}): Promise<OperationResult> {
    const [toolName, method] = key.split('.');
    const tool = surface.tools.find((candidate) => candidate.name === toolName);
    if (tool === undefined) throw new Error(`missing tool ${toolName}`);
    return tool.execute({ method, args }, ctx);
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'pyric-checkpoint-confirm-'));
    sandbox = initializeSandbox();
    ctx = createSurfaceContext(sandbox, projectDir);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('creates a new checkpoint without confirm and refuses unconfirmed overwrites', async () => {
    expect((await call('firestore.setDoc', { path: 'docs/d1', data: { step: 1 } })).ok).toBe(true);

    const first = await call('sandbox.checkpoint', { name: 'base' });
    expect(first.ok).toBe(true);
    expect((first.data as { overwrote: boolean }).overwrote).toBe(false);

    expect((await call('firestore.setDoc', { path: 'docs/d1', data: { step: 2 } })).ok).toBe(true);

    const refusedOmitted = await call('sandbox.checkpoint', { name: 'base' });
    expect(refusedOmitted.ok).toBe(false);
    expect((refusedOmitted.data as { field?: string }).field).toBe('confirm');
    expect(refusedOmitted.summary).toContain('confirm: true');

    const refusedFalse = await call('sandbox.checkpoint', { name: 'base', confirm: false });
    expect(refusedFalse.ok).toBe(false);
    expect((refusedFalse.data as { field?: string }).field).toBe('confirm');

    const restored = await call('sandbox.restore', { name: 'base', confirm: true });
    expect(restored.ok).toBe(true);
    const readOriginal = await call('firestore.getDoc', { path: 'docs/d1' });
    expect((readOriginal.data as { data: { step: number } }).data.step).toBe(1);

    expect((await call('firestore.setDoc', { path: 'docs/d1', data: { step: 3 } })).ok).toBe(true);
    const confirmedOverwrite = await call('sandbox.checkpoint', { name: 'base', confirm: true });
    expect(confirmedOverwrite.ok).toBe(true);
    expect((confirmedOverwrite.data as { overwrote: boolean }).overwrote).toBe(true);

    expect((await call('firestore.setDoc', { path: 'docs/d1', data: { step: 4 } })).ok).toBe(true);
    expect((await call('sandbox.restore', { name: 'base', confirm: true })).ok).toBe(true);
    const readUpdated = await call('firestore.getDoc', { path: 'docs/d1' });
    expect((readUpdated.data as { data: { step: number } }).data.step).toBe(3);
  });

  it('guides neighbouring confirmation flag names to confirm', async () => {
    const renamed = await call('sandbox.checkpoint', { name: 'base', force: true });
    expect(renamed.ok).toBe(false);
    expect(renamed.summary).toContain("'confirm'");
  });
});
