import { expect, test } from 'bun:test';
import { createBridge } from '../../../src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../src/bridge/server/peer.js';
import { WORKER_PORT_CAPABILITY, type BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';

const requests: InboundMessage[] = [
  { t: 'op', id: 'read-during-restart', method: 'getDoc', path: 'notes/one' },
  { t: 'tool', id: 'tool-during-restart', name: 'firestore_get_document', args: { path: 'notes/one' } },
  { t: 'sub', subId: 'listen-during-restart', target: { __ref: 'doc', path: 'notes/one' } },
];

for (const failure of ['peer gone', 'capability missing', 'send throws']) {
  for (const request of requests) {
    test(`${request.t} receives a correlated refusal when ${failure}`, () => {
      const bridge = createBridge({ version: 'test' });
      const output: BridgeMessage[] = [];
      let shouldThrow = false;
      const disconnect = bridge.registerSandboxPeer(frame => {
        const failsSend = shouldThrow && frame.type === 'worker-message';
        if (failsSend) throw new Error('transport failure');
      }, [], 'initial-host', [WORKER_PORT_CAPABILITY]);
      const consumer = createConsumerSession(bridge, frame => output.push(frame));
      let disconnectReplacement = () => {};
      try {
        consumer.handleMessage({ type: 'attach', protocol: 1, transport: 'worker-port' });
        const attachment = output.find(frame => frame.type === 'attach-ack');
        expect(attachment).toBeDefined();
        const losesPeer = failure === 'peer gone';
        const losesCapability = failure === 'capability missing';
        if (losesPeer) disconnect();
        if (losesCapability) disconnectReplacement = bridge.registerSandboxPeer(() => {}, [], 'replacement-host', []);
        shouldThrow = failure === 'send throws';

        expect(() => consumer.handleMessage({ type: 'worker-message', message: request })).not.toThrow();

        const response = output.find(frame => frame.type === 'worker-message-result');
        const code = shouldThrow ? 'unknown' : 'unimplemented';
        expect(response).toMatchObject({ clientSessionId: attachment?.clientSessionId });
        const isSubscription = request.t === 'sub';
        if (isSubscription) {
          expect(response).toMatchObject({ message: { t: 'snap', subId: request.subId, value: { __error: { code } } } });
        } else {
          const hasRequestId = 'id' in request;
          if (!hasRequestId) throw new Error('Expected a request with an id');
          expect(response).toMatchObject({ message: { t: 'res', id: request.id, ok: false, error: { code } } });
        }
      } finally {
        consumer.dispose();
        disconnectReplacement();
        disconnect();
      }
    });
  }
}
