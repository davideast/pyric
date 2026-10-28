import { afterEach, expect, test } from 'bun:test';
import { getHostedFirestore, type HostedConnectionState } from '../../../src/serve/worker/client/websocket-connection.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import type { InitPayload } from '../../../src/serve/init-payload.js';
import { movedSocketUrl } from '../../../src/serve/entries/moved-host.js';

// Where a hosted client redials after its host stops. A Node process resolves
// the url again before each reattach, so a host that came back on another
// port is found there; while no host answers, it keeps trying on the
// reconnect backoff.

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** One host on its own port, answering every attach as `instanceId` of `projectKey`. */
function startHost(instanceId: string, received: BridgeMessage[], projectKey = 'orbit') {
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
            clientSessionId: `client-${instanceId}`, projectKey, hostInstanceId: instanceId,
            resumeToken: `token-${instanceId}`, capabilities: ['worker-port'],
          } satisfies BridgeMessage));
        }
      },
    },
  });
  const stop = (): void => { void server.stop(true); };
  cleanups.push(stop);
  const origin = `http://127.0.0.1:${server.port as number}`;
  return { url: `ws://127.0.0.1:${server.port as number}/__pyric/sandbox`, origin, stop };
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
  // While no host answers, the client keeps resolving on its backoff
  // (250 ms doubling): a few attempts in 1.5 s, not a tight loop.
  await until(() => resolutions >= 2, describe);
  const before = resolutions;
  await new Promise(resolve => setTimeout(resolve, 1_500));
  expect(resolutions - before).toBeLessThanOrEqual(4);
  current = startHost('boot-2', moved).url;

  await until(() => appConfigCount(moved) === 1, describe);
  const reattach = moved.find(message => message.type === 'attach') as Extract<BridgeMessage, { type: 'attach' }>;
  expect(reattach.hostInstanceId).toBe('boot-2');
  expect(states.at(-1)).toBe('attached');
}, 20_000);

test('a Node client waits out a neighbouring project\'s host and a host that is not the Node host, then reattaches to its own', async () => {
  // While this project's host restarts, discovery can find a host in a parent or
  // sibling folder. The client must not attach there: another project's ack closes it for good.
  const first: BridgeMessage[] = [];
  const neighbour: BridgeMessage[] = [];
  const offHost: BridgeMessage[] = [];
  const back: BridgeMessage[] = [];
  const firstHost = startHost('boot-1', first);
  const neighbourHost = startHost('neighbour-1', neighbour, 'web');
  const offNodeHost = startHost('off-1', offHost);
  const attached = { projectKey: 'orbit', bridgeUrl: 'ws://localhost:5173/__pyric/sandbox' };
  const initOf = (projectKey: string, hosted: boolean): InitPayload =>
    ({ projectKey, hosted, bridgeUrl: 'ws://localhost:5173/__pyric/sandbox' }) as InitPayload;
  let serving: { origin: string; init: InitPayload } | undefined;
  const refusals: string[] = [];
  const states: HostedConnectionState[] = [];
  const db = getHostedFirestore({
    url: firstHost.url,
    projectKey: 'orbit',
    initialHostInstanceId: 'boot-1',
    currentHostInstanceId: async () => 'boot-2',
    currentUrl: async () => {
      if (serving === undefined) throw new Error('no host is running');
      try {
        return movedSocketUrl(serving.init, serving.origin, attached);
      } catch (error) {
        refusals.push((error as Error).message);
        throw error;
      }
    },
    onConnection: state => states.push(state),
  });
  cleanups.push(() => db.port.close());
  db.port.postMessage({ t: 'appConfig', options: { projectId: 'orbit' } } as InboundMessage);
  const describe = () => JSON.stringify({ states, refusals, neighbour, offHost, back });
  await until(() => states.includes('attached'), describe);

  firstHost.stop();
  serving = { origin: neighbourHost.origin, init: initOf('web', true) };
  await until(() => refusals.some(message => message.includes('serves another project')), describe);
  serving = { origin: offNodeHost.origin, init: initOf('orbit', false) };
  await until(() => refusals.some(message => message.includes('is not the Node host')), describe);
  const backHost = startHost('boot-2', back);
  serving = { origin: backHost.origin, init: initOf('orbit', true) };

  await until(() => appConfigCount(back) === 1, describe);
  expect(neighbour.filter(message => message.type === 'attach')).toHaveLength(0);
  expect(offHost.filter(message => message.type === 'attach')).toHaveLength(0);
  expect(states).not.toContain('closed');
  expect(states.at(-1)).toBe('attached');
}, 30_000);
