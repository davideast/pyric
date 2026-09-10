/**
 * The client's saved-state wrappers, over a port that answers instead of a
 * SharedWorker.
 *
 * What these pin is the wire each wrapper writes: the method string the host
 * dispatches on, the payload beside it, and the reply the wrapper hands back.
 * The host's own behaviour is pinned in `serve/worker/checkpoints.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import {
  deleteWorkerCheckpoint,
  listWorkerCheckpoints,
  restoreWorkerCheckpoint,
  saveWorkerCheckpoint,
  type WorkerCheckpoint,
} from '../../../../src/serve/worker/client/connection.js';
import { wirePort } from '../../../../src/serve/worker/client/core.js';
import type { ClientDb, ClientPort } from '../../../../src/serve/worker/client/handles.js';
import type { InboundMessage } from '../../../../src/serve/worker/protocol.js';

/**
 * A port that records what the client sent and answers each op with `reply`.
 * The answer is delivered asynchronously, the way a worker's reply arrives.
 */
function answeringPort(reply: unknown): {
  db: ClientDb;
  sent: InboundMessage[];
} {
  const sent: InboundMessage[] = [];
  const port: ClientPort = {
    onmessage: null,
    postMessage(message: InboundMessage) {
      // `wirePort` opens the clock mirror on every port. It is not part of the
      // wire these wrappers write, and it is pinned in `client/clock.test.ts`.
      if (message.t === 'clock-subscribe') return;
      sent.push(message);
      const { id } = message as { id: string };
      queueMicrotask(() => {
        port.onmessage?.({ data: { t: 'res', id, ok: true, value: reply } } as MessageEvent);
      });
    },
    start() {},
    close() {},
  };
  wirePort(port);
  return { db: { __kind: 'client-db', port }, sent };
}

const LISTING: WorkerCheckpoint[] = [
  { name: 'before-import', at: 1, counts: { firestore: 2, database: 1, storage: 0, auth: 1 } },
];

describe('the client saved-state wrappers', () => {
  it('saves under a name through the checkpoint op', async () => {
    const { db, sent } = answeringPort({ ok: true });
    await saveWorkerCheckpoint(db, 'before-import');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: 'op', method: 'checkpoint', name: 'before-import' });
  });

  it('lists through the listCheckpoints op and resolves the host reply', async () => {
    const { db, sent } = answeringPort({ checkpoints: LISTING });
    expect(await listWorkerCheckpoints(db)).toEqual(LISTING);
    expect(sent[0]).toMatchObject({ t: 'op', method: 'listCheckpoints' });
  });

  it('lists nothing when the host reply carries no checkpoints', async () => {
    const { db } = answeringPort({});
    expect(await listWorkerCheckpoints(db)).toEqual([]);
  });

  it('restores a name through the restore op', async () => {
    const { db, sent } = answeringPort({ ok: true });
    await restoreWorkerCheckpoint(db, 'before-import');
    expect(sent[0]).toMatchObject({ t: 'op', method: 'restore', name: 'before-import' });
  });

  it('deletes a name through the deleteCheckpoint op', async () => {
    const { db, sent } = answeringPort({ ok: true });
    await deleteWorkerCheckpoint(db, 'before-import');
    expect(sent[0]).toMatchObject({ t: 'op', method: 'deleteCheckpoint', name: 'before-import' });
  });

  it('gives each op its own correlation id', async () => {
    const { db, sent } = answeringPort({ ok: true });
    await saveWorkerCheckpoint(db, 'one');
    await saveWorkerCheckpoint(db, 'two');
    const ids = sent.map((message) => (message as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
  });
});
