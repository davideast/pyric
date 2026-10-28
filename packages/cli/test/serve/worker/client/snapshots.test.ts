import { describe, expect, it } from 'bun:test';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { wirePort } from '../../../../src/serve/worker/client/core.js';
import { deleteDoc } from '../../../../src/serve/worker/client/firestore-writes.js';
import { makeDocSnapshot, makeQuerySnapshot } from '../../../../src/serve/worker/client/snapshots.js';

describe('worker query snapshot references', () => {
  it('returns a full reference that can be passed directly to deleteDoc', async () => {
    const sent: InboundMessage[] = [];
    const port = {
      onmessage: null as ((event: MessageEvent<OutboundMessage>) => void) | null,
      postMessage(message: InboundMessage) {
        sent.push(message);
        if (message.t === 'op') {
          queueMicrotask(() => {
            port.onmessage?.({
              data: { t: 'res', id: message.id, ok: true, value: undefined },
            } as MessageEvent<OutboundMessage>);
          });
        }
      },
      start() {},
      addEventListener() {},
    } as unknown as MessagePort;
    wirePort(port);
    const snapshot = makeQuerySnapshot(
      {
        docs: [
          {
            id: 'delete-me',
            path: 'notes/delete-me',
            exists: true,
            data: { json: '{}' },
          },
        ],
      },
      port,
    );

    await deleteDoc(snapshot.docs[0]!.ref);

    expect(snapshot.docs[0]!.ref.descriptor.path).toBe('notes/delete-me');
    expect(sent).toContainEqual(
      expect.objectContaining({ t: 'op', method: 'deleteDoc', path: 'notes/delete-me' }),
    );
  });
});

function silentPort(): MessagePort {
  const port = {
    onmessage: null,
    postMessage() {},
    start() {},
    addEventListener() {},
  } as unknown as MessagePort;
  wirePort(port);
  return port;
}

// FP-5 (#1358): production marks only the doc with a pending write, as the
// committed capture `firestore-query-doc-pending-writes` shows.
describe('worker query snapshot document metadata', () => {
  it('gives each document its own hasPendingWrites, not the query value', () => {
    const snapshot = makeQuerySnapshot(
      {
        hasPendingWrites: true,
        docs: [
          { id: 'a', path: 'c/a', exists: true, data: { json: '{"n":1}' }, hasPendingWrites: false },
          { id: 'z', path: 'c/z', exists: true, data: { json: '{"n":2}' }, hasPendingWrites: true },
        ],
      },
      silentPort(),
    );

    expect(snapshot.metadata.hasPendingWrites).toBe(true);
    expect(snapshot.docs.map((doc) => [doc.id, doc.metadata.hasPendingWrites])).toEqual([['a', false], ['z', true]]);
  });

  it('reads a document frame with no flag as settled', () => {
    const snapshot = makeQuerySnapshot(
      { hasPendingWrites: true, docs: [{ id: 'a', path: 'c/a', exists: true, data: { json: '{}' } }] },
      silentPort(),
    );

    expect(snapshot.docs[0]!.metadata.hasPendingWrites).toBe(false);
  });
});

// FP-13 (#1358): production builds a new object on each data() call, so a
// caller that mutates one result does not change the next.
describe('worker snapshot data copies', () => {
  const raw = { id: 'a', path: 'c/a', exists: true, data: { json: '{"a":1,"m":{"k":1}}' } };

  it('returns a fresh object with equal contents from each data() call', () => {
    const doc = makeDocSnapshot(raw, silentPort());
    const first = doc.data() as { a: unknown; m: { k: unknown } };
    const second = doc.data();

    expect(first).not.toBe(second);
    expect(first).toEqual(second as typeof first);
    first.a = 'mutated';
    first.m.k = 99;
    expect(doc.data()).toEqual({ a: 1, m: { k: 1 } });
    expect(doc.get('m.k')).toBe(1);
  });

  it('returns a fresh object from each query document', () => {
    const snapshot = makeQuerySnapshot({ docs: [raw] }, silentPort());
    (snapshot.docs[0]!.data() as { a: unknown }).a = 'mutated';

    expect(snapshot.docs[0]!.data()).toEqual({ a: 1, m: { k: 1 } });
  });
});
