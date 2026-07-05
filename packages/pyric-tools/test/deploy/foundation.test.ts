/**
 * Foundation primitives (Slice 1) — `ProjectScope`, `Outcome`,
 * `AdminApiError`, `memoizeTtl`, `withResolvedScope`.
 *
 * `fromServiceAccount` is covered by a separate integration test
 * (needs a real SA + token endpoint to exercise meaningfully).
 */

import { describe, it, expect } from 'bun:test';
import {
  AdminApiError,
  memoizeTtl,
  withResolvedScope,
  type ProjectScope,
} from '../../src/deploy/index.js';

function fakeScope(token = 'TKN'): ProjectScope {
  return { projectId: 'p', resolveToken: async () => token };
}

describe('AdminApiError', () => {
  it('carries status + body + message', () => {
    const e = new AdminApiError(403, 'forbidden', 'Permission denied');
    expect(e.status).toBe(403);
    expect(e.body).toBe('forbidden');
    expect(e.message).toBe('Permission denied');
    expect(e.name).toBe('AdminApiError');
    expect(e).toBeInstanceOf(Error);
  });

  it('caps oversized bodies at 8 KiB with a truncation marker', () => {
    const huge = 'x'.repeat(20_000);
    const e = new AdminApiError(500, huge, 'Server error');
    expect(e.body.length).toBeLessThan(huge.length);
    expect(e.body).toMatch(/\[truncated, \d+ bytes\]$/);
    expect(e.body.startsWith('x'.repeat(8192))).toBe(true);
  });

  it('does not truncate bodies under the cap', () => {
    const small = 'tiny error response';
    const e = new AdminApiError(400, small, 'Bad request');
    expect(e.body).toBe(small);
  });
});

describe('memoizeTtl — plain-string resolver', () => {
  it('caches the resolved value within TTL', async () => {
    let calls = 0;
    const memo = memoizeTtl(
      async () => {
        calls++;
        return `tok-${calls}`;
      },
      { ttlMs: 10_000 },
    );
    expect(await memo()).toBe('tok-1');
    expect(await memo()).toBe('tok-1');
    expect(await memo()).toBe('tok-1');
    expect(calls).toBe(1);
  });

  it('refreshes at 90% of TTL by default', async () => {
    let calls = 0;
    const memo = memoizeTtl(
      async () => {
        calls++;
        return `tok-${calls}`;
      },
      { ttlMs: 100 },
    );
    expect(await memo()).toBe('tok-1');
    // 90% of 100ms = 90ms. Wait past that.
    await new Promise((r) => setTimeout(r, 95));
    expect(await memo()).toBe('tok-2');
    expect(calls).toBe(2);
  });

  it('honors refreshAtFraction', async () => {
    let calls = 0;
    const memo = memoizeTtl(
      async () => {
        calls++;
        return `tok-${calls}`;
      },
      { ttlMs: 100, refreshAtFraction: 0.5 },
    );
    expect(await memo()).toBe('tok-1');
    await new Promise((r) => setTimeout(r, 60));
    expect(await memo()).toBe('tok-2');
  });

  it('coalesces concurrent refreshes', async () => {
    let calls = 0;
    const memo = memoizeTtl(
      async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return `tok-${calls}`;
      },
      { ttlMs: 1000 },
    );
    const [a, b, c] = await Promise.all([memo(), memo(), memo()]);
    expect(a).toBe('tok-1');
    expect(b).toBe('tok-1');
    expect(c).toBe('tok-1');
    expect(calls).toBe(1);
  });
});

describe('memoizeTtl — hung-resolver timeout (M7)', () => {
  it('rejects with a timeout error if the resolver hangs past resolverTimeoutMs', async () => {
    const memo = memoizeTtl(
      // Resolver never resolves.
      () => new Promise<string>(() => {}),
      { ttlMs: 1000, resolverTimeoutMs: 30 },
    );
    await expect(memo()).rejects.toThrow(/did not complete within 30ms/);
  });

  it('lets the next caller try afresh after a timeout — no deadlock', async () => {
    let attempts = 0;
    const memo = memoizeTtl(
      () => {
        attempts++;
        if (attempts === 1) return new Promise<string>(() => {}); // hang first time
        return Promise.resolve('TKN-recovered');
      },
      { ttlMs: 1000, resolverTimeoutMs: 30 },
    );
    await expect(memo()).rejects.toThrow();
    // Inflight clears in `finally` even when racing the timeout —
    // the next caller starts a brand-new resolver invocation.
    expect(await memo()).toBe('TKN-recovered');
    expect(attempts).toBe(2);
  });
});

describe('memoizeTtl — structured-token resolver', () => {
  it('parses expiresIn (seconds) into ttlMs', async () => {
    let calls = 0;
    const memo = memoizeTtl(async () => {
      calls++;
      return { token: `tok-${calls}`, expiresIn: 100 }; // 100 seconds → 100_000 ms
    });
    expect(await memo()).toBe('tok-1');
    expect(await memo()).toBe('tok-1');
    expect(calls).toBe(1);
  });

  it('throws if structured resolver omits expiresIn and no ttlMs override', async () => {
    const memo = memoizeTtl(async () => ({ token: 'tok-1' }));
    await expect(memo()).rejects.toThrow(/expiresIn/);
  });

  it('honors explicit ttlMs override on structured resolver', async () => {
    let calls = 0;
    const memo = memoizeTtl(
      async () => ({ token: `tok-${++calls}`, expiresIn: 9999 }),
      { ttlMs: 100 },
    );
    expect(await memo()).toBe('tok-1');
    await new Promise((r) => setTimeout(r, 95));
    expect(await memo()).toBe('tok-2');
  });
});

describe('withResolvedScope', () => {
  it('wraps fn in ok: true on success', async () => {
    const result = await withResolvedScope(fakeScope(), async (token, projectId) => {
      expect(token).toBe('TKN');
      expect(projectId).toBe('p');
      return { written: 1 };
    });
    expect(result).toEqual({ ok: true, data: { written: 1 } });
  });

  it('non-AdminApiError resolver throw buckets as unknown (NOT permission-denied)', async () => {
    const failing: ProjectScope = {
      projectId: 'p',
      resolveToken: async () => {
        throw new Error('offline'); // Transport / network failure.
      },
    };
    const result = await withResolvedScope(failing, async () => 'unused');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Transport failures must NOT be labeled permission-denied — that
    // sends consumers hunting for IAM issues that don't exist.
    expect(result.code).toBe('unknown');
    expect(result.message).toContain('offline');
  });

  it('AdminApiError(401) from resolver buckets as permission-denied', async () => {
    const failing: ProjectScope = {
      projectId: 'p',
      resolveToken: async () => {
        throw new AdminApiError(401, 'unauthorized', 'OAuth token rejected');
      },
    };
    const result = await withResolvedScope(failing, async () => 'unused');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('permission-denied');
  });

  it('AdminApiError(403) from fn buckets as permission-denied', async () => {
    const result = await withResolvedScope(fakeScope(), async () => {
      throw new AdminApiError(403, 'forbidden', 'Caller lacks role');
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('permission-denied');
  });

  it('AdminApiError(404) from fn buckets as not-found (extended code surface)', async () => {
    const result = await withResolvedScope<unknown>(fakeScope(), async () => {
      throw new AdminApiError(404, 'gone', 'Resource not found');
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not-found');
  });

  it('AdminApiError(500) from fn buckets as unknown', async () => {
    const result = await withResolvedScope(fakeScope(), async () => {
      throw new AdminApiError(500, 'oops', 'Upstream 500');
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unknown');
  });

  it('non-AdminApiError fn failure buckets as unknown', async () => {
    const result = await withResolvedScope(fakeScope(), async () => {
      throw new Error('REST timeout');
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unknown');
    expect(result.message).toBe('REST timeout');
  });

  it('calls resolveToken per invocation (F4)', async () => {
    let calls = 0;
    const counting: ProjectScope = {
      projectId: 'p',
      resolveToken: async () => {
        calls++;
        return `TKN-${calls}`;
      },
    };
    await withResolvedScope(counting, async () => 'a');
    await withResolvedScope(counting, async () => 'b');
    await withResolvedScope(counting, async () => 'c');
    expect(calls).toBe(3);
  });
});
