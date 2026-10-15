/**
 * Host-side peer liveness (#965). Unit evidence: a fake socket and faked
 * timers. The integration test is the app scenario
 * `test/apps/host-closes-silent-page`.
 *
 * A web page frozen in the back-forward cache, a killed tab, or a sleeping
 * laptop leaves its socket open without ever closing it. The host watches a
 * worker-port page (the web hosted client) from its attach, and any other
 * client from its first `ping`, and closes the socket after the liveness
 * window passes with no frame from it, so the session takes the path a real
 * close takes: the host is told the client was interrupted and runs its RTDB
 * onDisconnect operations. Clients that never send `ping` (native and remote
 * builds from before ADR-0019's heartbeat, and in-page sandbox peers) are
 * never closed for being quiet.
 *
 * A native or remote consumer's close, whatever its cause, also tells the host
 * the session was interrupted, unless the client already re-attached the
 * session on a newer socket (ADR-0019).
 *
 * `test/serve/fixtures/hosted-sqlite-peer-liveness.ts` drives the same path
 * against the real Node host with mocked timers, and
 * `hosted-sqlite-peer-liveness-socket.ts` with a real `ws` server and client;
 * `hosted-sqlite-relay-ondisconnect.ts` drives the native and remote consumer
 * path over a real `ws` socket.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import {
  HOST_PEER_LIVENESS_TIMEOUT_MS,
  HOSTED_HEARTBEAT_INTERVAL_MS,
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
} from '../../src/bridge/protocol.js';

/** The `ws` surface `attachPeer` consumes. */
function fakeSocket() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const sent: BridgeMessage[] = [];
  const self = {
    OPEN: 1,
    readyState: 1,
    sent,
    terminated: false,
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler);
      return self;
    },
    send(data: string) {
      sent.push(JSON.parse(data) as BridgeMessage);
    },
    close() {
      self.end();
    },
    terminate() {
      self.terminated = true;
      self.end();
    },
    end() {
      const isClosed = self.readyState !== self.OPEN;
      if (isClosed) return;
      self.readyState = 3;
      handlers.get('close')?.();
    },
    receive(message: BridgeMessage) {
      handlers.get('message')?.(Buffer.from(JSON.stringify(message)));
    },
    asWebSocket: () => self as unknown as Parameters<typeof attachPeer>[1],
  };
  return self;
}

/** A bridge with a recording host peer that owns worker ports, as the Node host does. */
function hostBridge() {
  const bridge = createBridge({ version: 'test' });
  const toHost: BridgeMessage[] = [];
  bridge.registerSandboxPeer(message => toHost.push(message), [], 'host', [WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY]);
  return { bridge, toHost };
}

function attachPage(bridge: ReturnType<typeof createBridge>) {
  const socket = fakeSocket();
  attachPeer(bridge, socket.asWebSocket());
  socket.receive({ type: 'attach', protocol: 1, transport: 'worker-port', clientInfo: { platform: 'browser' } });
  const ack = socket.sent.find(frame => frame.type === 'attach-ack');
  const clientSessionId = ack?.type === 'attach-ack' ? ack.clientSessionId : '';
  return { socket, clientSessionId };
}

/** Attach as Kotlin, Swift, Flutter and the Node remote client do: no transport, own session id. */
function attachRelayConsumer(bridge: ReturnType<typeof createBridge>, clientSessionId: string) {
  const socket = fakeSocket();
  attachPeer(bridge, socket.asWebSocket());
  socket.receive({ type: 'attach', protocol: 1, clientSessionId, clientInfo: { platform: 'kotlin' } });
  return socket;
}

function interruptionsOf(toHost: BridgeMessage[], clientSessionId: string): number {
  return toHost.filter(frame => frame.type === 'worker-client-interrupted' && frame.clientSessionId === clientSessionId).length;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('host peer liveness', () => {
  it('closes a heartbeating page that sends nothing for the window, and tells the host it was interrupted', () => {
    const { bridge, toHost } = hostBridge();
    const page = attachPage(bridge);
    jest.advanceTimersByTime(HOSTED_HEARTBEAT_INTERVAL_MS);
    page.socket.receive({ type: 'ping', id: 'hb-1' });

    jest.advanceTimersByTime(HOST_PEER_LIVENESS_TIMEOUT_MS - 1);
    expect(page.socket.terminated).toBe(false);
    expect(interruptionsOf(toHost, page.clientSessionId)).toBe(0);

    jest.advanceTimersByTime(1);
    expect(page.socket.terminated).toBe(true);
    expect(interruptionsOf(toHost, page.clientSessionId)).toBe(1);
  });

  it('counts any frame as traffic, not only ping', () => {
    const { bridge } = hostBridge();
    const page = attachPage(bridge);
    page.socket.receive({ type: 'ping', id: 'hb-1' });
    const steps = 4;
    for (let step = 0; step < steps; step += 1) {
      jest.advanceTimersByTime(HOST_PEER_LIVENESS_TIMEOUT_MS / 2);
      page.socket.receive({ type: 'worker-message', message: { t: 'clock-subscribe' } });
    }
    expect(page.socket.terminated).toBe(false);
  });

  it('keeps a page that heartbeats every interval open well past the window', () => {
    const { bridge, toHost } = hostBridge();
    const page = attachPage(bridge);
    const beats = Math.ceil((3 * HOST_PEER_LIVENESS_TIMEOUT_MS) / HOSTED_HEARTBEAT_INTERVAL_MS);
    for (let beat = 0; beat < beats; beat += 1) {
      page.socket.receive({ type: 'ping', id: `hb-${beat}` });
      jest.advanceTimersByTime(HOSTED_HEARTBEAT_INTERVAL_MS);
    }
    expect(page.socket.terminated).toBe(false);
    expect(interruptionsOf(toHost, page.clientSessionId)).toBe(0);
  });

  it('watches a worker-port page from its attach, so one frozen before its first ping is still closed', () => {
    const { bridge, toHost } = hostBridge();
    const page = attachPage(bridge);
    jest.advanceTimersByTime(HOST_PEER_LIVENESS_TIMEOUT_MS);
    expect(page.socket.terminated).toBe(true);
    expect(interruptionsOf(toHost, page.clientSessionId)).toBe(1);
  });

  it('never closes a client that never pings, such as an app built before the heartbeat, however long it is quiet', () => {
    const { bridge } = hostBridge();
    const socket = attachRelayConsumer(bridge, 'phone');
    expect(socket.sent.some(frame => frame.type === 'attach-ack')).toBe(true);
    jest.advanceTimersByTime(10 * HOST_PEER_LIVENESS_TIMEOUT_MS);
    expect(socket.terminated).toBe(false);
  });

  it('tells the host a native or remote consumer was interrupted when its socket closes', () => {
    const { bridge, toHost } = hostBridge();
    const socket = attachRelayConsumer(bridge, 'phone');
    socket.close();
    expect(interruptionsOf(toHost, 'phone')).toBe(1);
    expect(bridge.consumers.get('phone')).toBeUndefined();
  });

  it('closes a native or remote consumer that pings and goes silent, and tells the host it was interrupted', () => {
    const { bridge, toHost } = hostBridge();
    const socket = attachRelayConsumer(bridge, 'phone');
    socket.receive({ type: 'ping', id: 'hb-1' });
    jest.advanceTimersByTime(HOST_PEER_LIVENESS_TIMEOUT_MS);
    expect(socket.terminated).toBe(true);
    expect(interruptionsOf(toHost, 'phone')).toBe(1);
  });

  it('runs nothing when a replaced socket closes after the client re-attached on a newer one', () => {
    const { bridge, toHost } = hostBridge();
    const replaced = attachRelayConsumer(bridge, 'phone');
    const current = attachRelayConsumer(bridge, 'phone');
    replaced.close();
    expect(interruptionsOf(toHost, 'phone')).toBe(0);
    expect(bridge.consumers.get('phone')).toBeDefined();
    current.close();
    expect(interruptionsOf(toHost, 'phone')).toBe(1);
  });

  it('sends no interruption to an in-page sandbox peer, which does not accept it', () => {
    const bridge = createBridge({ version: 'test' });
    const toPeer: BridgeMessage[] = [];
    bridge.registerSandboxPeer(message => toPeer.push(message), [], 'page', [WORKER_RELAY_CAPABILITY]);
    const socket = attachRelayConsumer(bridge, 'phone');
    socket.close();
    expect(interruptionsOf(toPeer, 'phone')).toBe(0);
    expect(bridge.consumers.get('phone')).toBeUndefined();
  });

  it('watches any client from its first ping', () => {
    const { bridge } = hostBridge();
    const socket = fakeSocket();
    attachPeer(bridge, socket.asWebSocket());
    socket.receive({ type: 'attach', protocol: 1, clientSessionId: 'node', clientInfo: { platform: 'node' } });
    socket.receive({ type: 'ping', id: 'hb-1' });
    jest.advanceTimersByTime(HOST_PEER_LIVENESS_TIMEOUT_MS);
    expect(socket.terminated).toBe(true);
  });

  it('never closes an in-page sandbox peer that has not heartbeated', () => {
    const bridge = createBridge({ version: 'test' });
    const socket = fakeSocket();
    attachPeer(bridge, socket.asWebSocket());
    socket.receive({ type: 'hello', protocol: 1, tools: [], sandboxId: 'page' });
    expect(socket.sent.some(frame => frame.type === 'hello-ack')).toBe(true);
    jest.advanceTimersByTime(10 * HOST_PEER_LIVENESS_TIMEOUT_MS);
    expect(socket.terminated).toBe(false);
    expect(bridge.isSandboxConnected()).toBe(true);
  });

  it('stops watching once the socket closes', () => {
    const { bridge, toHost } = hostBridge();
    const page = attachPage(bridge);
    page.socket.receive({ type: 'ping', id: 'hb-1' });
    page.socket.close();
    expect(interruptionsOf(toHost, page.clientSessionId)).toBe(1);
    expect(jest.getTimerCount()).toBe(1); // only the resume retention remains
    jest.advanceTimersByTime(HOST_PEER_LIVENESS_TIMEOUT_MS);
    expect(page.socket.terminated).toBe(false);
  });
});
