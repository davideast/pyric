/**
 * `remoteSandbox()` — the lazy handle. Construction is synchronous and never
 * touches the wire; the connect (injected via `createLazyRemoteSandbox`, the
 * test seam) runs on the first op / `ready` access, fail-fast errors surface
 * there, and a failed connect is retried by the next op.
 */
import { describe, it, expect } from 'bun:test';
import { REMOTE_SANDBOX } from 'pyric/sandbox';
import {
  createLazyRemoteSandbox,
  createRemoteSandboxHandle,
  remoteSandbox,
  type RemoteSandbox,
  type RemoteSandboxChannel,
} from '../../src/remote/index.js';
import type { WorkerOpPayload } from '../../src/bridge/protocol.js';

/** A fake inner handle over a recording channel. */
function fakeInner(serveUrl = 'http://127.0.0.1:5000'): {
  handle: RemoteSandbox;
  ops: WorkerOpPayload[];
  subs: Array<{ unsubscribed: boolean }>;
  closed: () => boolean;
} {
  const ops: WorkerOpPayload[] = [];
  const subs: Array<{ unsubscribed: boolean }> = [];
  let closed = false;
  const channel: RemoteSandboxChannel = {
    op: (op) => {
      ops.push(op);
      return Promise.resolve({ ok: true, op: op.method });
    },
    subscribe: (_sub, _onSnap) => {
      const record = { unsubscribed: false };
      subs.push(record);
      return () => {
        record.unsubscribed = true;
      };
    },
  };
  const handle = createRemoteSandboxHandle({ channel, serveUrl, close: () => (closed = true) });
  return { handle, ops, subs, closed: () => closed };
}

describe('createLazyRemoteSandbox', () => {
  it('returns the branded handle synchronously without connecting', () => {
    let connects = 0;
    const lazy = createLazyRemoteSandbox(async () => {
      connects += 1;
      return fakeInner().handle;
    });
    expect(lazy[REMOTE_SANDBOX]).toBe(true);
    expect(typeof lazy.channel.op).toBe('function');
    expect(typeof lazy.rtdb.get).toBe('function');
    expect(typeof lazy.auth.listUsers).toBe('function');
    expect(connects).toBe(0);
  });

  it('connects once on the first op and reuses the connection', async () => {
    let connects = 0;
    const inner = fakeInner();
    const lazy = createLazyRemoteSandbox(async () => {
      connects += 1;
      return inner.handle;
    });
    await lazy.rtdb.get('users/a');
    await lazy.rtdb.set('users/b', { x: 1 });
    expect(connects).toBe(1);
    expect(inner.ops.map((o) => o.method)).toEqual(['rtdb.get', 'rtdb.set']);
  });

  it('surfaces the connect failure on the first op (not at construction)', async () => {
    const lazy = createLazyRemoteSandbox(async () => {
      throw Object.assign(new Error('no browser tab is connected to the sandbox — open http://x and retry.'), {
        code: 'unavailable',
      });
    });
    expect(lazy.channel.op({ method: 'getSnapshot' })).rejects.toThrow('no browser tab is connected');
  });

  it('retries the connect on the next op after a failure', async () => {
    let connects = 0;
    const inner = fakeInner();
    const lazy = createLazyRemoteSandbox(async () => {
      connects += 1;
      if (connects === 1) throw new Error('serve not up yet');
      return inner.handle;
    });
    await expect(lazy.channel.op({ method: 'getSnapshot' })).rejects.toThrow('serve not up yet');
    await lazy.channel.op({ method: 'getSnapshot' });
    expect(connects).toBe(2);
    expect(inner.ops).toHaveLength(1);
  });

  it('ready connects eagerly and resolves / rejects with the connect outcome', async () => {
    let connects = 0;
    const lazy = createLazyRemoteSandbox(async () => {
      connects += 1;
      return fakeInner().handle;
    });
    await lazy.ready;
    expect(connects).toBe(1);

    const failing = createLazyRemoteSandbox(async () => {
      throw new Error('no tab');
    });
    expect(failing.ready).rejects.toThrow('no tab');
  });

  it('subscribe before connect attaches after connect; unsubscribe works both sides', async () => {
    const inner = fakeInner();
    const lazy = createLazyRemoteSandbox(async () => inner.handle);

    // Unsubscribe BEFORE the connect settles → never attaches.
    const unsubEarly = lazy.channel.subscribe(
      { target: { service: 'rtdb', path: 'a' }, actAs: { mode: 'admin' } },
      () => {},
    );
    unsubEarly();
    await lazy.ready;
    expect(inner.subs).toHaveLength(0);

    // Normal flow: attaches, then the returned unsubscribe reaches through.
    const unsub = lazy.channel.subscribe(
      { target: { service: 'rtdb', path: 'b' }, actAs: { mode: 'admin' } },
      () => {},
    );
    await lazy.ready;
    expect(inner.subs).toHaveLength(1);
    unsub();
    expect(inner.subs[0]!.unsubscribed).toBe(true);
  });

  it('routes a connect failure under a subscription to onError', async () => {
    const lazy = createLazyRemoteSandbox(async () => {
      throw Object.assign(new Error('no tab'), { code: 'unavailable' });
    });
    const err = await new Promise<Error & { code: string }>((resolve) => {
      lazy.channel.subscribe(
        { target: { service: 'rtdb', path: 'a' }, actAs: { mode: 'admin' } },
        () => {},
        resolve,
      );
    });
    expect(err.code).toBe('unavailable');
    expect(err.message).toContain('no tab');
  });

  it('close() closes an established inner connection and fails later ops', async () => {
    const inner = fakeInner();
    const lazy = createLazyRemoteSandbox(async () => inner.handle);
    await lazy.ready;
    lazy.close();
    await Bun.sleep(0);
    expect(inner.closed()).toBe(true);
    expect(lazy.channel.op({ method: 'getSnapshot' })).rejects.toThrow('closed by the client');
  });

  it('adopts the discovered serveUrl once connected', async () => {
    const lazy = createLazyRemoteSandbox(async () => fakeInner('http://127.0.0.1:5050').handle);
    expect(lazy.serveUrl).toContain('pending discovery');
    await lazy.ready;
    expect(lazy.serveUrl).toBe('http://127.0.0.1:5050');
  });
});

describe('remoteSandbox', () => {
  it('is synchronous and fails fast on the first op when nothing is listening', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(),
    });
    const url = `http://127.0.0.1:${server.port}`;
    server.stop(true);

    const lazy = remoteSandbox({ url });
    expect(lazy[REMOTE_SANDBOX]).toBe(true);
    expect(lazy.serveUrl).toBe(url);
    expect(lazy.channel.op({ method: 'getSnapshot' })).rejects.toThrow(/failed to connect|timed out/);
  });
});
