import { afterEach, expect, test } from 'bun:test';
import {
  getHostedFirestore,
  type HostedConnectionState,
  type HostedSocketRealm,
} from '../../../src/serve/worker/client/websocket-connection.js';
import type { HostRestart } from '../../../src/serve/runtime/host-restart.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';

// Which host boot a hosted client presents when it reattaches after the host
// restarted. A Node process reads the new boot's id from init.json first, so
// the host holds its config as verified. A page presents the boot it was
// served by, so a stale bundle stays marked as from an earlier host (#1153).

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * One listening socket whose boot can change. `restart` closes every client
 * socket and answers later attaches as the new boot: a host restarted on the
 * same url, with no window in which another server could take the port.
 */
function startHost(received: BridgeMessage[]) {
  let instanceId = 'boot-1';
  const sockets = new Set<{ close(): void }>();
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      if (bunServer.upgrade(request)) return undefined;
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      open(socket) { sockets.add(socket); },
      close(socket) { sockets.delete(socket); },
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
  cleanups.push(() => { void server.stop(true); });
  return {
    port: server.port as number,
    restart(): void {
      instanceId = 'boot-2';
      for (const socket of [...sockets]) socket.close();
    },
  };
}

async function until(condition: () => boolean, describe: () => string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Condition was not met in time: ${describe()}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

type Attach = Extract<BridgeMessage, { type: 'attach' }>;
const attaches = (received: BridgeMessage[]): Attach[] =>
  received.filter((message): message is Attach => message.type === 'attach');
const appConfigs = (received: BridgeMessage[]): Array<Record<string, unknown>> => received
  .filter(message => message.type === 'worker-message')
  .map(message => (message as { message: { t: string } }).message as unknown as Record<string, unknown>)
  .filter(message => message.t === 'appConfig');

type ClientOptions = Pick<Parameters<typeof getHostedFirestore>[0], 'currentHostInstanceId' | 'onHostRestarted' | 'realm'>;

async function restartAcross(client: ClientOptions = {}) {
  const received: BridgeMessage[] = [];
  const host = startHost(received);
  const states: HostedConnectionState[] = [];
  const db = getHostedFirestore({
    url: `ws://127.0.0.1:${host.port}/__pyric/sandbox`,
    projectKey: 'orbit',
    initialHostInstanceId: 'boot-1',
    ...client,
    onConnection: state => states.push(state),
  });
  cleanups.push(() => db.port.close());
  db.port.postMessage({ t: 'appConfig', options: { projectId: 'orbit' } } as InboundMessage);
  const describe = () => JSON.stringify({ states, received });
  // Restart only once the host has read the first config. The client reports
  // attached right after sending it, and a socket closed before the host reads
  // that frame drops it, so the count below would never reach two.
  const hostHasFirstConfig = () => states.includes('attached') && appConfigs(received).length === 1;
  await until(hostHasFirstConfig, describe);
  host.restart();
  await until(() => appConfigs(received).length === 2, describe);
  return received;
}

test('a Node client presents the restarted host boot it read, and its config is not marked from an earlier host', async () => {
  const received = await restartAcross({ currentHostInstanceId: async () => 'boot-2' });
  const [initial, reattach] = attaches(received);
  expect(initial?.hostInstanceId).toBe('boot-1');
  expect(reattach?.hostInstanceId).toBe('boot-2');
  // A grant from the earlier boot cannot resume on this one.
  expect(reattach?.resumeToken).toBeUndefined();
  expect(appConfigs(received)[1]).toEqual({ t: 'appConfig', options: { projectId: 'orbit' } });
}, 20_000);

test('a client that cannot read the current boot presents the one it attached to, and is marked from an earlier host', async () => {
  const received = await restartAcross({ currentHostInstanceId: async () => { throw new Error('init.json is not served yet'); } });
  expect(attaches(received)[1]?.hostInstanceId).toBe('boot-1');
  expect(appConfigs(received)[1]).toEqual({ t: 'appConfig', options: { projectId: 'orbit' }, fromPriorHost: true });
}, 20_000);

test('a page presents the boot it was served by after a host restart, and is marked from an earlier host', async () => {
  const received = await restartAcross();
  const reattach = attaches(received)[1];
  expect(reattach?.hostInstanceId).toBe('boot-1');
  expect(reattach?.resumeToken).toBe('token-boot-1');
  expect(appConfigs(received)[1]).toEqual({ t: 'appConfig', options: { projectId: 'orbit' }, fromPriorHost: true });
}, 20_000);

// A page runs the bundle and rules its host served, so it reports a later
// boot to the page runtime, which warns. A Node process or service worker
// has no stale tab to reload and reports nothing.

const nodeRealm: HostedSocketRealm = {
  platform: 'node',
  createSocket: url => new WebSocket(url),
  releaseTimer: () => {},
  traffic: () => {},
};

test('a page reports a host that restarted since it loaded, once, and does not warn itself', async () => {
  const restarts: HostRestart[] = [];
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  cleanups.push(() => { console.warn = originalWarn; });
  await restartAcross({ onHostRestarted: restart => restarts.push(restart) });
  expect(restarts).toEqual([{ initialHostInstanceId: 'boot-1', currentHostInstanceId: 'boot-2' }]);
  expect(warnings).toEqual([]);
}, 20_000);

test('a Node process does not report a host restart', async () => {
  const restarts: HostRestart[] = [];
  await restartAcross({
    realm: nodeRealm,
    currentHostInstanceId: async () => 'boot-2',
    onHostRestarted: restart => restarts.push(restart),
  });
  expect(restarts).toEqual([]);
}, 20_000);

test('a service worker does not report a host restart', async () => {
  const scope = globalThis as { registration?: unknown; clients?: unknown };
  scope.registration = {};
  scope.clients = {};
  cleanups.push(() => { delete scope.registration; delete scope.clients; });
  const restarts: HostRestart[] = [];
  await restartAcross({ onHostRestarted: restart => restarts.push(restart) });
  expect(restarts).toEqual([]);
}, 20_000);
