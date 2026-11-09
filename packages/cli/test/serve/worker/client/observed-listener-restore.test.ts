import { describe, expect, it } from 'bun:test';
import type { ObservedCall } from 'pyric/sandbox';
import type { ClientPort } from '../../../../src/serve/worker/client/handles.js';
import {
  buildObserveFrame,
  trackObservedPortListener,
} from '../../../../src/serve/worker/client/observed-listener-restore.js';
import type { InboundMessage } from '../../../../src/serve/worker/protocol.js';

function fakePort(): ClientPort {
  return {
    onmessage: null,
    postMessage: () => undefined,
    start: () => undefined,
    close: () => undefined,
  };
}

describe('observed-listener-restore', () => {
  it('replays still-open listener attaches on session restore and omits detached listeners', () => {
    const port = fakePort();
    const attachLobby: ObservedCall = {
      service: 'firestore',
      method: 'onSnapshot',
      at: 1_000,
      outcome: { status: 'ok' },
      path: 'rooms/lobby',
      listener: { phase: 'attach', id: 'l-lobby', target: 'rooms/lobby', key: 'k-lobby' },
    };
    const attachScores: ObservedCall = {
      service: 'rtdb',
      method: 'onValue',
      at: 1_100,
      outcome: { status: 'ok' },
      instance: 'demo-default-rtdb',
      path: '/scores',
      listener: { phase: 'attach', id: 'l-scores', target: '/scores', key: 'k-scores' },
    };
    const detachLobby: ObservedCall = {
      ...attachLobby,
      at: 1_200,
      listener: { ...attachLobby.listener!, phase: 'detach' },
    };

    trackObservedPortListener(port, attachLobby, () => undefined);
    trackObservedPortListener(port, attachScores, () => undefined);
    trackObservedPortListener(port, detachLobby, () => undefined);

    const replayed: InboundMessage[] = [];
    port.restoreObservedListeners?.(async (msg) => {
      replayed.push(msg);
    });

    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({
      t: 'observe',
      call: attachScores,
    });
    expect(buildObserveFrame(attachScores, '/sw.js')).toMatchObject({
      t: 'observe',
      script: '/sw.js',
      call: attachScores,
    });
  });
});
