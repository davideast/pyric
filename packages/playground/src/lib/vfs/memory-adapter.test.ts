/**
 * Unit tests for the in-memory VFS adapter — the Node stand-in for OPFS.
 * Pure: no stores, no window, no network.
 */
import { describe, test, expect } from 'bun:test';
import { createMemoryVFSAdapter } from './memory-adapter';

describe('in-memory VFS adapter', () => {
  test('writeFile + readFile round-trips (utf8 → string)', async () => {
    const { promises: fs } = createMemoryVFSAdapter();
    await fs.writeFile('/workspace/firestore.rules', "rules_version = '2';");
    const v = await fs.readFile('/workspace/firestore.rules', 'utf8');
    expect(typeof v).toBe('string');
    expect(v).toContain('rules_version');
  });

  test('readFile without utf8 returns bytes', async () => {
    const { promises: fs } = createMemoryVFSAdapter();
    await fs.writeFile('/workspace/a.txt', 'hi');
    const v = await fs.readFile('/workspace/a.txt');
    expect(v instanceof Uint8Array).toBe(true);
  });

  test('missing file throws an ENOENT-coded error', async () => {
    const { promises: fs } = createMemoryVFSAdapter();
    await expect(fs.readFile('/workspace/nope', 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('writeFile auto-creates parent dirs; lstat + readdir reflect them', async () => {
    const { promises: fs } = createMemoryVFSAdapter();
    await fs.writeFile('/workspace/src/App.tsx', 'x');
    expect((await fs.lstat('/workspace/src')).isDirectory()).toBe(true);
    expect((await fs.lstat('/workspace/src/App.tsx')).isFile()).toBe(true);
    expect(await fs.readdir('/workspace/src')).toEqual(['App.tsx']);
  });

  test('unlink removes a file; unlinking again throws ENOENT', async () => {
    const { promises: fs } = createMemoryVFSAdapter();
    await fs.writeFile('/workspace/a', 'x');
    await fs.unlink('/workspace/a');
    await expect(fs.unlink('/workspace/a')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('mkdir recursive creates the chain', async () => {
    const { promises: fs } = createMemoryVFSAdapter();
    await fs.mkdir('/workspace/a/b/c', { recursive: true });
    expect((await fs.lstat('/workspace/a/b/c')).isDirectory()).toBe(true);
    expect(await fs.readdir('/workspace/a')).toEqual(['b']);
  });

  test('readdir lists immediate children, sorted', async () => {
    const { promises: fs } = createMemoryVFSAdapter();
    await fs.writeFile('/workspace/firestore.rules', 'r');
    await fs.writeFile('/workspace/src/App.tsx', 'a');
    expect(await fs.readdir('/workspace')).toEqual(['firestore.rules', 'src']);
  });

  test('overwrite replaces content and preserves the inode', async () => {
    const { promises: fs } = createMemoryVFSAdapter();
    await fs.writeFile('/workspace/r', 'v1');
    const ino1 = (await fs.lstat('/workspace/r')).ino;
    await fs.writeFile('/workspace/r', 'v2');
    expect(await fs.readFile('/workspace/r', 'utf8')).toBe('v2');
    expect((await fs.lstat('/workspace/r')).ino).toBe(ino1);
  });
});
