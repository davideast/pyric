/**
 * `database.crawl`, exercised through the service-tool surface: a bounded
 * structural view that reports child names and counts without ever carrying
 * a leaf value, and truncates once it reaches the requested depth.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../../../src/bridge/surface/index.js';

const surface = renderSurface(undefined);

/** A leaf value distinctive enough that its presence in a crawl would be unmistakable. */
const SECRET_LEAF_VALUE = 'top-secret-leaf-marker';

interface StructureNode {
  path: string;
  childCount: number;
  truncated: boolean;
  children: StructureNode[];
  schema: Record<string, string>;
}

function freshContext(): { ctx: SurfaceContext } {
  const sandbox = initializeSandbox();
  const projectDir = mkdtempSync(join(tmpdir(), 'pyric-crawl-'));
  return { ctx: createSurfaceContext(sandbox, projectDir) };
}

async function call(
  ctx: SurfaceContext,
  key: string,
  args: Record<string, unknown> = {},
): Promise<OperationResult> {
  const [toolName, method] = key.split('.');
  const tool = surface.tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) throw new Error(`no tool named ${toolName}`);
  return tool.execute({ method, args }, ctx);
}

/** Seed a tree three levels deep under one root, with a marked leaf at the bottom. */
async function seedTree(ctx: SurfaceContext): Promise<void> {
  await call(ctx, 'database.set', {
    path: 'rooms',
    value: {
      lobby: { members: { alice: { note: SECRET_LEAF_VALUE }, bob: { note: 'ok' } } },
      annex: { members: { carol: { note: 'ok' } } },
    },
  });
}

describe('database.crawl reports structure, never leaf values', () => {
  it('names child keys and counts, with no leaf value in the output', async () => {
    const { ctx } = freshContext();
    await seedTree(ctx);

    const crawled = await call(ctx, 'database.crawl', { path: 'rooms' });
    expect(crawled.ok).toBe(true);
    const root = crawled.data as StructureNode;
    expect(root.childCount).toBe(2);
    const childNames = root.children.map((child) => child.path.split('/').pop());
    expect(childNames.sort()).toEqual(['annex', 'lobby']);
    expect(JSON.stringify(root)).not.toContain(SECRET_LEAF_VALUE);
  });

  it('truncates at depth with a marker, before reaching the leaf', async () => {
    const { ctx } = freshContext();
    await seedTree(ctx);

    const crawled = await call(ctx, 'database.crawl', { path: 'rooms', depth: 1 });
    expect(crawled.ok).toBe(true);
    const root = crawled.data as StructureNode;
    const lobby = root.children.find((child) => child.path.endsWith('/lobby'));
    expect(lobby).toBeDefined();
    expect(lobby!.truncated).toBe(true);
    expect(lobby!.children).toHaveLength(0);
    expect(JSON.stringify(root)).not.toContain(SECRET_LEAF_VALUE);
  });

  it('does not change the sandbox state', async () => {
    const { ctx } = freshContext();
    await seedTree(ctx);
    const before = await call(ctx, 'database.get', { path: 'rooms' });

    await call(ctx, 'database.crawl', { path: 'rooms' });

    const after = await call(ctx, 'database.get', { path: 'rooms' });
    expect(after.data).toEqual(before.data);
  });
});
