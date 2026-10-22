import { afterEach, expect, test } from 'bun:test';
import { getHostedFirestore, type HostedConnectionState } from '../../../src/serve/worker/client/websocket-connection.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';

// Where a hosted client redials after its host stops. A Node process resolves
// the url again before each reattach, so a host that came back on another
// port is found there; while no host answers, it keeps trying on the
// reconnect backoff.

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** One host on its own port, answering every attach as `instanceId`. */
function startHost(instanceId: string, received: BridgeMessage[]) {
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      if (bunServer.upgrade(request)) return undefined;
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      message(socket, data) {
        const message = JSON.parse(String(data)) as BridgeMessage;
        received.push(message);
        if (message.type === 'attach') {
          socket.send(JSON.stringify({
            type: 'attach-ack', protocol: 1, bridgeVersion: 'test', peerConnected: true,
            clientSessionId: `client-${instanceId}`, projectKey: 'orbit', hostInstanceId: instanceId,
            resumeToken: `token-${instanceId}`, capabilities: ['worker-port'],
          } satisfies BridgeMessage));
        }
      },
    },
  });
  const stop = (): void => { void server.stop(true); };
  cleanups.push(stop);
  return { url: `ws://127.0.0.1:${server.port as number}/__pyric/sandbox`, stop };
}

async function until(condition: () => boolean, describe: () => string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Condition was not met in time: ${describe()}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const appConfigCount = (received: BridgeMessage[]): number => received
  .filter(message => message.type === 'worker-message')
  .filter(message => (message as { message: { t: string } }).message.t === 'appConfig')
  .length;

test('a Node client resolves the url again after a drop and reattaches to the host where it moved', async () => {
  const first: BridgeMessage[] = [];
  const moved: BridgeMessage[] = [];
  const firstHost = startHost('boot-1', first);
  let current: string | undefined = firstHost.url;
  let resolutions = 0;
  const states: HostedConnectionState[] = [];
  const db = getHostedFirestore({
    url: firstHost.url,
    projectKey: 'orbit',
    initialHostInstanceId: 'boot-1',
    currentHostInstanceId: async () => 'boot-2',
    currentUrl: async () => {
      resolutions += 1;
      if (current === undefined) throw new Error('no host is running');
      return current;
    },
    onConnection: state => states.push(state),
  });
  cleanups.push(() => db.port.close());
  db.port.postMessage({ t: 'appConfig', options: { projectId: 'orbit' } } as InboundMessage);
  const describe = () => JSON.stringify({ states, resolutions, first, moved });
  await until(() => states.includes('attached'), describe);

  current = undefined;
  firstHost.stop();
  // While no host answers, the client keeps resolving on its backoff.
  await until(() => resolutions >= 2, describe);
  current = startHost('boot-2', moved).url;

  await until(() => appConfigCount(moved) === 1, describe);
  const reattach = moved.find(message => message.type === 'attach') as Extract<BridgeMessage, { type: 'attach' }>;
  expect(reattach.hostInstanceId).toBe('boot-2');
  expect(states.at(-1)).toBe('attached');
}, 20_000);
