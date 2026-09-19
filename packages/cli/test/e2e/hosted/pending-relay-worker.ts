import type { InboundMessage } from '../../../src/serve/worker/protocol.js';

declare const self: { onconnect: (event: MessageEvent) => void };

// A controlled wire counterpart: hold one client's replies while serving the others.
self.onconnect = event => {
  const port = event.ports[0];
  const hasNoPort = port === undefined;
  if (hasNoPort) throw new Error('The capacity worker received no port.');
  const held: Array<() => void> = [];
  let released = false;
  port.onmessage = (incoming: MessageEvent<InboundMessage>) => {
    const message = incoming.data;
    const hasNoCorrelation = !('id' in message);
    if (hasNoCorrelation) return;
    const isDisconnect = message.t === 'disconnect';
    if (isDisconnect) {
      port.postMessage({ t: 'res', id: message.id, ok: true });
      port.close();
      return;
    }
    const releasesReplies = message.clientSessionId === 'release';
    if (releasesReplies) {
      released = true;
      for (const reply of held.splice(0)) reply();
    }
    const reply = (): void => port.postMessage({ t: 'res', id: message.id, ok: true, value: 'completed' });
    const holdsReply = message.clientSessionId === 'busy' && !released;
    if (holdsReply) held.push(reply);
    else reply();
  };
  port.start();
};
