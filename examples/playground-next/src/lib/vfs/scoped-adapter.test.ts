/**
 * Session-scoped adapter tests — the isolation seam itself.
 *
 * Run against the in-memory adapter as the inner filesystem (same
 * `OPFSPromisesAPI` contract as the browser OPFS adapter), so the
 * mount/translation/write-gate logic is exercised headlessly.
 */
import { describe, expect, it } from 'bun:test';
import { createMemoryVFSAdapter } from './memory-adapter';
import { createScopedVFSAdapter, normalizeVirtualPath } from './scoped-adapter';

const code = (e: unknown): string | undefined => (e as { code?: string })?.code;

describe('createScopedVFSAdapter — mounting', () => {
  it('two session ids over one inner fs → disjoint trees at the same virtual paths', async () => {
    const inner = createMemoryVFSAdapter();
    const a = createScopedVFSAdapter(inner, { realRoot: '/sessions/aaa' });
    const b = createScopedVFSAdapter(inner, { realRoot: '/sessions/bbb' });

    await a.promises.writeFile('/workspace/firestore.rules', 'rules A');
    await b.promises.writeFile('/workspace/firestore.rules', 'rules B');
    await a.promises.writeFile('/workspace/src/App.tsx', 'export const A = 1;');

    expect(await a.promises.readFile('/workspace/firestore.rules', 'utf8')).toBe('rules A');
    expect(await b.promises.readFile('/workspace/firestore.rules', 'utf8')).toBe('rules B');

    // B never sees A's extra file.
    await expect(b.promises.readFile('/workspace/src/App.tsx', 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // The real tree shows both containers side by side.
    expect(await inner.promises.readdir('/sessions')).toEqual(['aaa', 'bbb']);
    expect(
      await inner.promises.readFile('/sessions/aaa/workspace/firestore.rules', 'utf8'),
    ).toBe('rules A');
  });

  it('deleting in one session leaves the other untouched', async () => {
    const inner = createMemoryVFSAdapter();
    const a = createScopedVFSAdapter(inner, { realRoot: '/sessions/aaa' });
    const b = createScopedVFSAdapter(inner, { realRoot: '/sessions/bbb' });
    await a.promises.writeFile('/workspace/x.txt', 'ax');
    await b.promises.writeFile('/workspace/x.txt', 'bx');

    await a.promises.unlink('/workspace/x.txt');
    expect(await b.promises.readFile('/workspace/x.txt', 'utf8')).toBe('bx');
  });

  it('readdir/stat on the virtual root work before any write', async () => {
    const inner = createMemoryVFSAdapter();
    const a = createScopedVFSAdapter(inner, { realRoot: '/sessions/fresh' });
    expect(await a.promises.readdir('/')).toEqual([]);
    const st = await a.promises.stat('/');
    expect(st.isDirectory()).toBe(true);
  });

  it('`..` cannot escape the mount', async () => {
    const inner = createMemoryVFSAdapter();
    const a = createScopedVFSAdapter(inner, { realRoot: '/sessions/aaa' });
    await a.promises.writeFile('/workspace/../../../etc/passwd', 'gotcha');
    // Normalized to virtual /etc/passwd → real /sessions/aaa/etc/passwd.
    expect(
      await inner.promises.readFile('/sessions/aaa/etc/passwd', 'utf8'),
    ).toBe('gotcha');
    await expect(inner.promises.readFile('/etc/passwd', 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('errors come back in virtual coordinates (no real-root leak)', async () => {
    const inner = createMemoryVFSAdapter();
    const a = createScopedVFSAdapter(inner, { realRoot: '/sessions/aaa' });
    try {
      await a.promises.readFile('/workspace/missing.txt', 'utf8');
      throw new Error('expected ENOENT');
    } catch (e) {
      expect(code(e)).toBe('ENOENT');
      expect((e as Error).message).not.toContain('/sessions/aaa');
      expect((e as Error).message).toContain('/workspace/missing.txt');
    }
  });

  it('absolute symlink targets round-trip in virtual coordinates', async () => {
    const inner = createMemoryVFSAdapter();
    const a = createScopedVFSAdapter(inner, { realRoot: '/sessions/aaa' });
    await a.promises.writeFile('/workspace/real.txt', 'content');
    await a.promises.symlink('/workspace/real.txt', '/workspace/link.txt');

    // Stored against the real tree (resolvable by the inner adapter)…
    expect(await inner.promises.readlink('/sessions/aaa/workspace/link.txt')).toBe(
      '/sessions/aaa/workspace/real.txt',
    );
    // …but read back in virtual coordinates.
    expect(await a.promises.readlink('/workspace/link.txt')).toBe('/workspace/real.txt');
  });

  it('mkdir without recursive works near the virtual root on a fresh container', async () => {
    const inner = createMemoryVFSAdapter();
    const a = createScopedVFSAdapter(inner, { realRoot: '/sessions/aaa' });
    await a.promises.mkdir('/workspace');
    expect((await a.promises.stat('/workspace')).isDirectory()).toBe(true);
  });
});

describe('createScopedVFSAdapter — write gate (EROFS)', () => {
  it('blocks every mutating call when canWrite() is false; reads still work', async () => {
    const inner = createMemoryVFSAdapter();
    let writable = true;
    const a = createScopedVFSAdapter(inner, {
      realRoot: '/sessions/aaa',
      canWrite: () => writable,
    });
    await a.promises.writeFile('/workspace/keep.txt', 'kept');
    await a.promises.mkdir('/workspace/dir', { recursive: true });

    writable = false;
    await expect(a.promises.writeFile('/workspace/x.txt', 'x')).rejects.toMatchObject({
      code: 'EROFS',
    });
    await expect(a.promises.unlink('/workspace/keep.txt')).rejects.toMatchObject({ code: 'EROFS' });
    await expect(a.promises.mkdir('/workspace/d2')).rejects.toMatchObject({ code: 'EROFS' });
    await expect(a.promises.rmdir('/workspace/dir')).rejects.toMatchObject({ code: 'EROFS' });
    await expect(a.promises.symlink('/workspace/keep.txt', '/workspace/l')).rejects.toMatchObject({
      code: 'EROFS',
    });
    await expect(a.promises.chmod('/workspace/keep.txt', 0o755)).rejects.toMatchObject({
      code: 'EROFS',
    });

    // Reads unaffected.
    expect(await a.promises.readFile('/workspace/keep.txt', 'utf8')).toBe('kept');
    expect(await a.promises.readdir('/workspace')).toEqual(['dir', 'keep.txt']);

    // Gate is evaluated at call time — flipping back re-enables writes.
    writable = true;
    await a.promises.writeFile('/workspace/x.txt', 'x');
    expect(await a.promises.readFile('/workspace/x.txt', 'utf8')).toBe('x');
  });
});

describe('normalizeVirtualPath', () => {
  it('resolves dot segments and clamps at root', () => {
    expect(normalizeVirtualPath('/a/b/../c')).toBe('/a/c');
    expect(normalizeVirtualPath('/../..')).toBe('/');
    expect(normalizeVirtualPath('//a//b/')).toBe('/a/b');
    expect(normalizeVirtualPath('/')).toBe('/');
  });
});
