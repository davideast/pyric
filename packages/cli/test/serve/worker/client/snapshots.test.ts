import { describe, expect, it } from 'bun:test';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { wirePort } from '../../../../src/serve/worker/client/core.js';
import { deleteDoc } from '../../../../src/serve/worker/client/firestore-writes.js';
import { makeQuerySnapshot } from '../../../../src/serve/worker/client/snapshots.js';

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
