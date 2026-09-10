/**
 * `database.push`, exercised through the service-tool surface: the honesty
 * invariant is that the minted key's timestamp component decodes to the
 * pinned clock, not the wall clock the process runs on, and that two pushes
 * issued in the same instant still sort in call order.
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

/** The alphabet a push key's first eight characters are drawn from, published by RTDB. */
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

/** The epoch milliseconds a push key's leading eight characters encode. */
function decodeTimestamp(key: string): number {
  let ms = 0;
  for (const character of key.slice(0, 8)) {
    ms = ms * 64 + PUSH_CHARS.indexOf(character);
  }
  return ms;
}

function freshContext(): { ctx: SurfaceContext } {
  const sandbox = initializeSandbox();
  const projectDir = mkdtempSync(join(tmpdir(), 'pyric-push-'));
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

describe('database.push mints a key from the sandbox clock', () => {
  it('the key decodes to the exact pinned instant', async () => {
    const { ctx } = freshContext();
    const pinned = await call(ctx, 'sandbox.setClock', { isoTime: '2026-06-01T00:00:00.000Z' });
    expect(pinned.ok).toBe(true);

    const pushed = await call(ctx, 'database.push', { path: 'rooms', value: { open: true } });
    expect(pushed.ok).toBe(true);
    const key = (pushed.data as { key: string }).key;
    expect(key).toHaveLength(20);
    expect(decodeTimestamp(key)).toBe(Date.parse('2026-06-01T00:00:00.000Z'));
  });

  it('two pushes in one instant stay ordered', async () => {
    const { ctx } = freshContext();
    await call(ctx, 'sandbox.setClock', { isoTime: '2026-06-01T00:00:00.000Z' });

    const first = await call(ctx, 'database.push', { path: 'rooms', value: { seat: 1 } });
    const second = await call(ctx, 'database.push', { path: 'rooms', value: { seat: 2 } });
    const firstKey = (first.data as { key: string }).key;
    const secondKey = (second.data as { key: string }).key;
    expect(decodeTimestamp(firstKey)).toBe(decodeTimestamp(secondKey));
    expect(firstKey < secondKey).toBe(true);
  });

  it('the value is readable back at the returned path', async () => {
    const { ctx } = freshContext();
    const pushed = await call(ctx, 'database.push', { path: 'rooms', value: { name: 'Lobby' } });
    const path = (pushed.data as { path: string }).path;

    const read = await call(ctx, 'database.get', { path });
    expect((read.data as { value: { name: string } }).value.name).toBe('Lobby');
  });

  it('a push with no value creates nothing readable at the new child', async () => {
    const { ctx } = freshContext();
    const pushed = await call(ctx, 'database.push', { path: 'rooms' });
    expect(pushed.ok).toBe(true);
    const path = (pushed.data as { path: string }).path;

    const read = await call(ctx, 'database.get', { path });
    expect((read.data as { exists: boolean }).exists).toBe(false);
    expect((read.data as { value: unknown }).value).toBeNull();
  });
});
