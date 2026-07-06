/**
 * VFS→UI notification plumbing — the stale-preview fix.
 *
 * The preview recompiles on `srcVersion` (esbuild reads imported files
 * fresh from the VFS), so every mutation path must bump it for
 * /workspace/src/ paths. These tests pin the pure store semantics of
 * the notify functions (no VFS needed: mirrored-path re-reads are
 * try/caught for headless contexts).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { useFilesStore } from '~/lib/store/files';
import { notifyVfsPathChanged, notifyVfsWrite } from './bootstrap';

function versions() {
  const s = useFilesStore.getState();
  return { tree: s.treeVersion, src: s.srcVersion };
}

beforeEach(() => {
  // Counters are monotonic; capture deltas per test instead of resetting.
});

describe('VFS mutation notifications', () => {
  test('a write under /workspace/src/ bumps BOTH tree and src versions', () => {
    const before = versions();
    notifyVfsWrite('/workspace/src/components/Board.tsx', 'export const x = 1;');
    const after = versions();
    expect(after.tree).toBe(before.tree + 1);
    expect(after.src).toBe(before.src + 1);
  });

  test('a write outside src/ bumps the tree only (no pointless recompile)', () => {
    const before = versions();
    notifyVfsWrite('/workspace/tests/moves.test.json', '{}');
    const after = versions();
    expect(after.tree).toBe(before.tree + 1);
    expect(after.src).toBe(before.src);
  });

  test('a content-less mutation (rm/mv from the shell) bumps versions too', () => {
    const before = versions();
    notifyVfsPathChanged('/workspace/src/lib/util.ts');
    const after = versions();
    expect(after.tree).toBe(before.tree + 1);
    expect(after.src).toBe(before.src + 1);
  });

  test('a mirrored-path change without a VFS (headless) does not throw', () => {
    expect(() => notifyVfsPathChanged('/workspace/src/App.tsx')).not.toThrow();
  });
});
