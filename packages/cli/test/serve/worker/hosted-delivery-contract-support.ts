/**
 * A loopback WebSocket host for the web hosted client's delivery-contract
 * tests (ADR-0019, 2026-10-17 amendment, D5 to D10). It records every worker
 * frame in arrival order, answers every operation except the ones a test holds
 * back, and lets a test push a frame to the client on the current socket.
 */
import { afterEach } from 'bun:test';
import { getHostedFirestore, type HostedConnectionState } from '../../../src/serve/worker/client/websocket-connection.js';
import { nextId, rawRpc } from '../../../src/serve/worker/client/core.js';
import type { ClientDb } from '../../../src/serve/worker/client/handles.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

export const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

export type WorkerFrame = { t: string; id?: string; subId?: string; method?: string };
type Socket = { send(data: string): void };

export class Host {
  readonly frames: WorkerFrame[] = [];
  /** Methods this host leaves unanswered, so they stay in flight. */
  readonly unanswered = new Set<string>();
  /** The value this host answers for a method; null when absent. */
  readonly answers = new Map<string, unknown>();
  readonly port: number;
  private server: ReturnType<typeof Bun.serve> | undefined;
  private socket: Socket | undefined;

  constructor() {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('probe') });
    this.port = probe.port as number;
    void probe.stop(true);
    cleanups.push(() => this.stop());
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/__pyric/sandbox`;
  }

  /** Frames for one subscription, as `t` values in arrival order. */
  subscriptionFrames(subId: string): string[] {
    return this.frames.filter(frame => frame.subId === subId).map(frame => frame.t);
  }

  /** Sends `message` to the client on the current socket. */
  push(message: OutboundMessage): void {
    this.socket?.send(JSON.stringify({ type: 'worker-message-result', message } satisfies BridgeMessage));
  }

  /** Sends raw text, such as a frame that is not JSON, on the current socket. */
  pushRaw(data: string): void {
    this.socket?.send(data);
  }

  start(): void {
    const frames = this.frames;
    const host = this;
    this.server = Bun.serve({
      port: this.port,
      fetch(request, bunServer) {
        if (bunServer.upgrade(request)) return undefined;
        return new Response('upgrade required', { status: 426 });
      },
      websocket: {
        message(socket, data) {
          host.socket = socket;
          const message = JSON.parse(String(data)) as BridgeMessage;
          if (message.type === 'attach') {
            socket.send(JSON.stringify({
              type: 'attach-ack', protocol: 1, bridgeVersion: 'test', peerConnected: true,
              clientSessionId: 'client', projectKey: 'orbit', hostInstanceId: 'host-1', capabilities: ['worker-port'],
            } satisfies BridgeMessage));
            return;
          }
          if (message.type !== 'worker-message') return;
          const frame = message.message as WorkerFrame;
          frames.push(frame);
          if (frame.t !== 'op') return;
          const method = frame.method ?? '';
          const staysInFlight = host.unanswered.has(method);
          if (staysInFlight) return;
          const value = host.answers.get(method) ?? null;
          socket.send(JSON.stringify({ type: 'worker-message-result', message: { t: 'res', id: frame.id, ok: true, value } }));
        },
      },
    });
  }

  stop(): void {
    void this.server?.stop(true);
    this.server = undefined;
    this.socket = undefined;
  }
}

/** Waits for a condition on this single-threaded event loop; it is a wait, never the assertion. */
export async function until(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition was not met in time.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export interface Client { db: ClientDb; states: HostedConnectionState[] }

export function open(host: Host): Client {
  const states: HostedConnectionState[] = [];
  const db = getHostedFirestore({ url: host.url, projectKey: 'orbit', retryInitialConnection: true, onConnection: state => states.push(state) });
  cleanups.push(() => { try { db.port.close(); } catch { /* already closed */ } });
  return { db, states };
}

export async function attached(host: Host): Promise<Client> {
  host.start();
  const client = open(host);
  await until(() => client.states.includes('attached'));
  return client;
}

/** A client that attached, then lost its socket; `reattached` turns true on the next attach. */
export async function dropped(host: Host): Promise<Client & { reattached: () => boolean }> {
  const client = await attached(host);
  host.stop();
  await until(() => client.states.at(-1) === 'interrupted');
  const reattached = (): boolean => client.states.filter(state => state === 'attached').length > 1;
  return { ...client, reattached };
}

/** Answered once every frame posted before it has reached the host: the socket is ordered. */
export function barrier(db: ClientDb): Promise<unknown> {
  return rawRpc(db.port, { t: 'op', id: nextId(), method: 'ping' } as unknown as InboundMessage);
}

/** A promise that the test settles by hand. */
export function gate<T>(): { promise: Promise<T>; open(value: T): void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>(resolve => { open = resolve; });
  return { promise, open };
}

/** The new subscription ids `run` added to `table`. */
export function addedKeys(table: Map<string, unknown>, run: () => void): string[] {
  const before = new Set(table.keys());
  run();
  return [...table.keys()].filter(key => !before.has(key));
}
