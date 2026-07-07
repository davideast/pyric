/**
 * `getVFS()` wiring tests — adapter selection + session-mount rules.
 *
 * The headless (memory) path must be byte-identical to the
 * pre-container behavior: no session concept, `resetVFS()` isolation.
 * The browser path is simulated by stubbing `navigator.storage` so
 * `opfsAvailable()` reports true; we only assert mount/selection
 * logic, never actual OPFS I/O (covered by scoped-adapter tests over
 * the same promises contract).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  ensureSessionVFS,
  getActiveVFSSessionId,
  getVFS,
  isVFSReadOnly,
  resetVFS,
  sessionContainerRoot,
  setActiveVFSSessionId,
  setVFSReadOnly,
} from './index';

function stubOPFS(): () => void {
  const nav = navigator as unknown as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(nav, 'storage');
  Object.defineProperty(nav, 'storage', {
    configurable: true,
    value: { getDirectory: () => Promise.reject(new Error('stub OPFS root')) },
  });
  return () => {
    if (had) Object.defineProperty(nav, 'storage', had);
    else delete nav.storage;
  };
}

afterEach(() => {
  resetVFS();
});

describe('getVFS — headless (no OPFS)', () => {
  it('returns the memory adapter with no session requirement; resetVFS isolates', async () => {
    const a = getVFS();
    await a.promises.writeFile('/workspace/x.txt', 'one');
    expect(getVFS()).toBe(a); // cached
    resetVFS();
    const b = getVFS();
    expect(b).not.toBe(a);
    await expect(b.promises.readFile('/workspace/x.txt', 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('getVFS — browser (OPFS available)', () => {
  it('throws before a session id is established (no silent global mount)', () => {
    const restore = stubOPFS();
    try {
      expect(() => getVFS()).toThrow(/session/);
    } finally {
      restore();
    }
  });

  it('mounts per session id: same id → cached adapter, new id → new mount', () => {
    const restore = stubOPFS();
    try {
      setActiveVFSSessionId('session-a');
      const a1 = getVFS();
      const a2 = getVFS();
      expect(a2).toBe(a1);

      setActiveVFSSessionId('session-b');
      const b = getVFS();
      expect(b).not.toBe(a1);
      expect(getActiveVFSSessionId()).toBe('session-b');
    } finally {
      restore();
    }
  });

  it('ensureSessionVFS establishes the mount (migrate skipped when OPFS is stubbed-out)', async () => {
    // Without the stub OPFS is unavailable → ensureSessionVFS only
    // records the id. That's the headless-safe contract.
    await ensureSessionVFS('session-c');
    expect(getActiveVFSSessionId()).toBe('session-c');
  });

  it('read-only flag round-trips and is reset by resetVFS', () => {
    expect(isVFSReadOnly()).toBe(false);
    setVFSReadOnly(true);
    expect(isVFSReadOnly()).toBe(true);
    resetVFS();
    expect(isVFSReadOnly()).toBe(false);
  });
});

describe('sessionContainerRoot — id sanitization', () => {
  it('keeps uuid-shaped ids intact', () => {
    expect(sessionContainerRoot('3f2a9c1e-7b4d-4f06-9a51-2c8e0d7b6a41')).toBe(
      '/sessions/3f2a9c1e-7b4d-4f06-9a51-2c8e0d7b6a41',
    );
  });

  it('neutralizes path-traversal attempts in crafted ids', () => {
    expect(sessionContainerRoot('..')).toBe('/sessions/_');
    expect(sessionContainerRoot('../../etc')).toBe('/sessions/.._.._etc');
    expect(sessionContainerRoot('a/b')).toBe('/sessions/a_b');
  });
});
