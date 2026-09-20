import { expect, test } from 'bun:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import type { BridgeMessage } from '../../../../src/bridge/protocol.js';

// The SDK and transport run unchanged; only browser I/O lives outside the realm.
test('Messaging worker installs during an initial outage and receives after the host returns', async () => {
  const bundle = await build({
    stdin: { contents: `export { initializeApp, deleteApp } from 'pyric/app';
      export { getMessaging, onBackgroundMessage } from './messaging-sw.js';`,
      resolveDir: new URL('../../../../src/serve/entries/', import.meta.url).pathname },
    bundle: true, platform: 'browser', format: 'iife', globalName: 'sdk', write: false,
  });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const lifecycle = new Map<string, (event: { waitUntil(promise: Promise<void>): void }) => void>();
  const sockets: Socket[] = [];
  let delivered!: () => void;
  const received = new Promise<void>(resolve => { delivered = resolve; });
  class Socket {
    static OPEN = 1;
    readyState = 1;
    listeners = new Map<string, (event: any) => void>();
    constructor() { sockets.push(this); queueMicrotask(() => this.listeners.get('open')?.({})); }
    addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, listener); }
    receive(frame: BridgeMessage) {
      queueMicrotask(() => this.listeners.get('message')?.({ data: JSON.stringify(frame) }));
    }
    send(encoded: string) {
      const frame: BridgeMessage = JSON.parse(encoded);
      if (frame.type === 'attach') {
        // The first connection never completes its attachment.
        if (this === sockets[0]) return;
        this.receive({ type: 'attach-ack', protocol: 1, bridgeVersion: 'dev', peerConnected: true,
          clientSessionId: 'worker', projectKey: 'orbit', capabilities: ['worker-port'] });
      }
      if (frame.type !== 'worker-message') return;
      const message = frame.message;
      if (message.t === 'sub' && message.target === 'messaging.background') {
        this.receive({ type: 'worker-message-result', message: {
          t: 'snap', subId: message.subId, value: { messageId: 'after-outage', data: { text: 'hello' } },
        } });
      }
      if (message.t === 'op' || message.t === 'disconnect') {
        this.receive({ type: 'worker-message-result', message: { t: 'res', id: message.id, ok: true, value: {} } });
      }
    }
    close() { this.readyState = 3; }
  }
  const sdk = runInNewContext(bundle.outputFiles[0]!.text + '\nsdk', {
    console, TextEncoder, TextDecoder, URL, AbortController, MessageEvent, crypto, performance, queueMicrotask,
    indexedDB: new IDBFactory(), location: new URL('https://app.example/'),
    registration: { scope: 'https://app.example/' }, clients: {}, WebSocket: Socket,
    addEventListener: (type: string, listener: any) => lifecycle.set(type, listener),
    fetch: async () => Response.json({ hosted: true, bridgeUrl: '/__pyric/sandbox', projectKey: 'orbit' }),
    setTimeout: (fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout,
  }) as typeof import('../../../../src/serve/entries/messaging-sw.js') & typeof import('pyric/app');
  const app = sdk.initializeApp({ projectId: 'orbit' });
  const stop = sdk.onBackgroundMessage(sdk.getMessaging(app), payload => {
    expect(payload.messageId).toBe('after-outage'); delivered();
  });
  const lifetimes: Promise<void>[] = [];
  lifecycle.get('install')?.({ waitUntil: work => lifetimes.push(work) });
  lifecycle.get('activate')?.({ waitUntil: work => lifetimes.push(work) });
  const installed = Promise.allSettled(lifetimes);
  try {
    // The initialization promise creates the socket asynchronously.
    for (let i = 0; sockets.length === 0 && i < 100; i++) await Bun.sleep(1);
    expect(sockets.length).toBe(1);
    sockets[0]!.listeners.get('close')?.({ code: 1006 });
    const outcomes = await installed;
    expect(outcomes.every(outcome => outcome.status === 'fulfilled')).toBe(true);
    await Promise.race([received, Bun.sleep(2000).then(() => { throw new Error('No delivery after initial outage'); })]);
    expect(sockets.length).toBeGreaterThan(1);
  } finally {
    stop();
    await sdk.deleteApp(app).catch(() => {});
    for (const timer of timers) clearTimeout(timer);
  }
});
