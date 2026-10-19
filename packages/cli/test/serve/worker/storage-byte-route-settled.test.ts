/**
 * Storage waits for the transport to know its byte route (#1082).
 *
 * A Node process's first call is often an upload, issued before its hosted
 * connection has attached. Until the attachment says whether the host has a
 * byte route, the client cannot tell frames from the route, and a host with a
 * route refuses bytes sent as frames. These tests drive the worker client's
 * Storage calls over a fake port whose `byteRouteSettled` the test controls.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { getStorage, ref, uploadBytes, uploadBytesResumable } from '../../../src/serve/worker/client/storage.js';
import { setHoldDeadlineForTesting } from '../../../src/serve/worker/client/held-messages.js';
import type { ClientDb, ClientPort } from '../../../src/serve/worker/client/handles.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';

interface FakeTransport {
  db: ClientDb;
  sent: InboundMessage[];
  settle(): void;
}

function fakeTransport(): FakeTransport {
  const sent: InboundMessage[] = [];
  let known = false;
  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
  const port: ClientPort = {
    onmessage: null,
    postMessage(message) {
      sent.push(message);
      const isOperation = message.t === 'op';
      if (isOperation) {
        queueMicrotask(() => port.onmessage?.(new MessageEvent('message', {
          data: { t: 'res', id: message.id, ok: true, value: { fullPath: 'uploads/a.txt', size: 1, contentType: 'text/plain' } },
        })));
      }
    },
    start() {},
    close() {},
    byteRouteSettled() {
      return known ? undefined : settled;
    },
  };
  return {
    db: { __kind: 'client-db', port },
    sent,
    settle() {
      known = true;
      resolveSettled();
    },
  };
}

const storageFrames = (sent: InboundMessage[]): string[] =>
  sent.flatMap(message => {
    const method = message.t === 'op' ? (message as { method?: string }).method : undefined;
    return method?.startsWith('storage.') ? [method] : [];
  });

afterEach(() => setHoldDeadlineForTesting(undefined));

describe('Storage before the byte route is known', () => {
  it('holds an upload until the transport settles, then sends it the way the host takes bytes', async () => {
    const transport = fakeTransport();
    const target = ref(getStorage(transport.db), 'uploads/a.txt');
    const upload = uploadBytes(target, new Uint8Array([1]));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(storageFrames(transport.sent)).toEqual([]);
    transport.settle();
    void upload.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(storageFrames(transport.sent).length).toBeGreaterThan(0);
  });

  it('starts a resumable upload once the transport settles', async () => {
    const transport = fakeTransport();
    const task = uploadBytesResumable(ref(getStorage(transport.db), 'uploads/b.txt'), new Uint8Array([2]));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(storageFrames(transport.sent)).toEqual([]);
    transport.settle();
    task.then(undefined, () => undefined);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(storageFrames(transport.sent).length).toBeGreaterThan(0);
    task.cancel();
  });

  it('fails like a held message when the transport never settles within the hold deadline', async () => {
    setHoldDeadlineForTesting(30);
    const transport = fakeTransport();
    const error = await uploadBytes(ref(getStorage(transport.db), 'uploads/c.txt'), new Uint8Array([3])).catch(e => e);
    expect((error as { code?: string }).code).toBe('unavailable');
    expect(String((error as Error).message)).toContain('was not restored within 10 seconds');
    expect(storageFrames(transport.sent)).toEqual([]);
  });
});
