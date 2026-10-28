/**
 * A loopback WebSocket host for the web hosted client's call-order tests
 * (ADR-0019, 2026-10-17 amendment, D1 and D2). It records every worker frame
 * in arrival order and answers every operation at once.
 */
import { afterEach } from 'bun:test';
import { getHostedFirestore, type HostedConnectionState } from '../../../src/serve/worker/client/websocket-connection.js';
import { nextId, rawRpc } from '../../../src/serve/worker/client/core.js';
import type { ClientDb } from '../../../src/serve/worker/client/handles.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';

export const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

export type WorkerFrame = { t: string; id?: string; subId?: string; method?: string };

export class Host {
  readonly frames: WorkerFrame[] = [];
  private server: ReturnType<typeof Bun.serve> | undefined;
  readonly port: number;

  constructor() {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('probe') });
    this.port = probe.port as number;
    void probe.stop(true);
    cleanups.push(() => this.stop());
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/__pyric/sandbox`;
  }

  /** Methods of the operations received, in arrival order, limited to `methods`. */
  methods(...methods: string[]): string[] {
    return this.frames.map(frame => frame.method ?? '').filter(method => methods.includes(method));
  }

  start(): void {
    const frames = this.frames;
    this.server = Bun.serve({
      port: this.port,
      fetch(request, bunServer) {
        if (bunServer.upgrade(request)) return undefined;
        return new Response('upgrade required', { status: 426 });
      },
      websocket: {
        message(socket, data) {
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
          const value = { token: 'token', fullPath: 'stored', name: 'stored', size: 1 };
          socket.send(JSON.stringify({ type: 'worker-message-result', message: { t: 'res', id: frame.id, ok: true, value } }));
        },
      },
    });
  }

  stop(): void {
    void this.server?.stop(true);
    this.server = undefined;
  }
}

export async function until(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition was not met in time.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

export function open(host: Host): { db: ClientDb; states: HostedConnectionState[] } {
  const states: HostedConnectionState[] = [];
  const db = getHostedFirestore({ url: host.url, projectKey: 'orbit', retryInitialConnection: true, onConnection: state => states.push(state) });
  cleanups.push(() => { try { db.port.close(); } catch { /* already closed */ } });
  return { db, states };
}

export async function attached(host: Host): Promise<{ db: ClientDb; states: HostedConnectionState[] }> {
  host.start();
  const client = open(host);
  await until(() => client.states.includes('attached'));
  return client;
}

/** Answered once every frame posted before it has reached the host: the socket is ordered. */
export function barrier(db: ClientDb): Promise<unknown> {
  return rawRpc(db.port, { t: 'op', id: nextId(), method: 'ping' } as unknown as InboundMessage);
}

/** A promise that the test settles by hand. */
export function gate<T>(): { promise: Promise<T>; open(value: T): void; fail(error: Error): void } {
  let open!: (value: T) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => { open = resolve; fail = reject; });
  return { promise, open, fail };
}

/** A Blob whose bytes arrive when the test says, as a slow `File` read would. */
export class GatedBlob extends Blob {
  readonly read = gate<ArrayBuffer>();
  override arrayBuffer(): Promise<ArrayBuffer> {
    return this.read.promise;
  }
}
