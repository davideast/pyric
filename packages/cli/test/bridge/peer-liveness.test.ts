/**
 * Host-side peer liveness (#965).
 *
 * A web page frozen in the back-forward cache, a killed tab, or a sleeping
 * laptop leaves its socket open without ever closing it. Once a client has
 * heartbeated, the host closes its socket after the liveness window passes
 * with no frame from it, so the session takes the path a real close takes:
 * the host is told the client was interrupted and runs its RTDB onDisconnect
 * operations. Clients that never send `ping` (native, remote, and in-page
 * sandbox peers) are never closed for being quiet.
 *
 * `test/serve/fixtures/hosted-sqlite-peer-liveness.ts` drives the same path
 * against the real Node host, where the onDisconnect write and the listener
 * release are observed.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import {
  HOST_PEER_LIVENESS_TIMEOUT_MS,
  HOSTED_HEARTBEAT_INTERVAL_MS,
  WORKER_PORT_CAPABILITY,
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
  bridge.registerSandboxPeer(message => toHost.push(message), [], 'host', [WORKER_PORT_CAPABILITY]);
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

  it('never closes a consumer that has not heartbeated, however long it is quiet', () => {
    // Native and remote consumers send no application ping (ADR-0019).
    const { bridge } = hostBridge();
    const page = attachPage(bridge);
    jest.advanceTimersByTime(10 * HOST_PEER_LIVENESS_TIMEOUT_MS);
    expect(page.socket.terminated).toBe(false);
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
