/**
 * Every event a host emits names the connection that sent its operation.
 *
 * Both hosts call `handleMessage`, so these cases run once for the
 * SharedWorker and the Node host: a page's own Firestore, RTDB and Storage
 * calls carry that page's id, a second page carries another, a bridge relay is
 * admin code, a tool frame is an MCP call, a Studio frame is Studio's, and a
 * port the Node host admitted for a server process using the client SDK is
 * `node`. Each page's event subscription hands it its own id.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, toOperationRecord, type EventCaller, type SandboxEvent } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import { markPortConnection } from '../../../../src/serve/worker/host/caller.js';
import { pageTabId } from '../../../../src/serve/worker/client/tab-id.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { bytesToBase64 } from '../../../../src/serve/worker/protocol.js';
import { setRules } from 'pyric/sandbox/firestore';
import { allowWorkerServicesForTransportTests } from '../permissive-services.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

interface FakePort extends PortLike { messages: OutboundMessage[] }

function fakePort(): FakePort {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage(message) { messages.push(message); } };
}

let databaseSequence = 0;
function makeCtx(): { ctx: HostCtx; events: SandboxEvent[] } {
  const sandbox = initializeSandbox();
  allowWorkerServicesForTransportTests(sandbox, `pyric-caller-${++databaseSequence}-${Math.random().toString(36).slice(2, 8)}`);
  setRules(sandbox, OPEN_RULES);
  const events: SandboxEvent[] = [];
  sandbox.onEvent((event) => events.push(event));
  const ctx: HostCtx = { db: getFirestore(sandbox), sandbox, instanceId: 'caller-test', subs: new Map() };
  return { ctx, events };
}

let opSequence = 0;
async function send(ctx: HostCtx, port: FakePort, frame: Record<string, unknown>): Promise<void> {
  const id = `caller-${++opSequence}`;
  await handleMessage(ctx, port, { id, ...frame } as InboundMessage);
  for (let tries = 0; tries < 50; tries++) {
    if (port.messages.some((message) => message.t === 'res' && message.id === id)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no reply to ${String(frame.method ?? frame.name)}`);
}

/** The callers of the operation records emitted while `run` ran. */
async function callersOf(events: SandboxEvent[], run: () => Promise<void>): Promise<Array<EventCaller | undefined>> {
  const before = events.length;
  await run();
  return events.slice(before).filter((event) => toOperationRecord(event) !== null).map((event) => event.caller);
}

/** The page id a port's event subscription delivered. */
async function subscribedPageId(ctx: HostCtx, port: FakePort): Promise<string | undefined> {
  await handleMessage(ctx, port, { t: 'sub', subId: `events-${++opSequence}`, target: 'events' } as InboundMessage);
  const batch = port.messages.find((message) => message.t === 'event');
  return batch?.t === 'event' ? batch.pageId : undefined;
}

describe('host: each event names the connection that sent its operation', () => {
  it("stamps a page's Firestore, RTDB and Storage calls with that page's id", async () => {
    const { ctx, events } = makeCtx();
    const page = fakePort();
    const pageId = await subscribedPageId(ctx, page);
    expect(pageId).toBeString();
    const expected = { kind: 'page', pageId };
    const callers = await callersOf(events, async () => {
      await send(ctx, page, { t: 'op', method: 'setDoc', path: 'notes/a', data: { text: 'hi' } });
      await send(ctx, page, { t: 'op', method: 'getDoc', path: 'notes/a' });
      await send(ctx, page, { t: 'op', method: 'rtdb.set', path: '/notes/a', value: 'hi' });
      await send(ctx, page, { t: 'op', method: 'storage.putBytes', path: 'notes/a.txt', dataB64: bytesToBase64(new TextEncoder().encode('hi')) });
    });
    expect(callers.length).toBeGreaterThanOrEqual(4);
    for (const caller of callers) expect(caller).toEqual(expected);
  });

  it('gives a second page its own id', async () => {
    const { ctx, events } = makeCtx();
    const first = fakePort();
    const second = fakePort();
    const firstId = await subscribedPageId(ctx, first);
    const secondId = await subscribedPageId(ctx, second);
    expect(secondId).not.toBe(firstId);
    const callers = await callersOf(events, () => send(ctx, second, { t: 'op', method: 'rtdb.set', path: '/tabs/b', value: 1 }));
    expect(callers).toContainEqual({ kind: 'page', pageId: secondId });
  });

  it("names every port of one tab, and the tab after a reload, by the tab's own id", async () => {
    const { ctx, events } = makeCtx();
    const appPort = fakePort();
    const controlPort = fakePort();
    await handleMessage(ctx, appPort, { t: 'appConfig', options: { projectId: 'demo-app' }, tabId: 'tab-1' } as InboundMessage);
    await handleMessage(ctx, controlPort, { t: 'sub', subId: 'events-tab', target: 'events', tabId: 'tab-1' } as InboundMessage);
    const batch = controlPort.messages.find((message) => message.t === 'event');
    expect(batch?.t === 'event' ? batch.pageId : undefined).toBe('tab-1');
    const callers = await callersOf(events, () => send(ctx, appPort, { t: 'op', method: 'rtdb.set', path: '/tabs/one', value: 1 }));
    expect(callers).toContainEqual({ kind: 'page', pageId: 'tab-1' });
    const reloaded = fakePort();
    await handleMessage(ctx, reloaded, { t: 'appConfig', options: { projectId: 'demo-app' }, tabId: 'tab-1' } as InboundMessage);
    const afterReload = await callersOf(events, () => send(ctx, reloaded, { t: 'op', method: 'rtdb.set', path: '/tabs/one', value: 2 }));
    expect(afterReload).toContainEqual({ kind: 'page', pageId: 'tab-1' });
  });

  it("names a tab without sessionStorage by one id across its app and control ports", async () => {
    const stored = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Reflect.deleteProperty(globalThis, 'sessionStorage');
    try {
      const { ctx, events } = makeCtx();
      const appPort = fakePort();
      const controlPort = fakePort();
      // The frames the page's clients send: each reads the tab id when it opens its port.
      await handleMessage(ctx, appPort, { t: 'appConfig', options: { projectId: 'demo-app' }, tabId: pageTabId() } as InboundMessage);
      await handleMessage(ctx, controlPort, { t: 'sub', subId: 'events-no-storage', target: 'events', tabId: pageTabId() } as InboundMessage);
      const batch = controlPort.messages.find((message) => message.t === 'event');
      const viewerId = batch?.t === 'event' ? batch.pageId : undefined;
      expect(viewerId).toBeString();
      const callers = await callersOf(events, () => send(ctx, appPort, { t: 'op', method: 'rtdb.set', path: '/tabs/no-storage', value: 1 }));
      expect(callers.length).toBeGreaterThan(0);
      for (const caller of callers) expect(caller).toEqual({ kind: 'page', pageId: viewerId });
    } finally {
      if (stored) Object.defineProperty(globalThis, 'sessionStorage', stored);
    }
  });

  it('stamps a bridge relay as admin, whether it arrives as a remote frame or a client session', async () => {
    const { ctx, events } = makeCtx();
    const page = fakePort();
    const callers = await callersOf(events, async () => {
      await send(ctx, page, { t: 'op', method: 'rtdb.set', path: '/server/a', value: 1, actAs: { mode: 'admin' }, relaySource: 'remote' });
      await send(ctx, page, { t: 'op', method: 'rtdb.set', path: '/server/b', value: 1, actAs: { mode: 'admin' }, clientSessionId: 'relay-1' });
    });
    expect(callers.length).toBeGreaterThanOrEqual(2);
    for (const caller of callers) expect(caller).toEqual({ kind: 'admin' });
  });

  it('stamps Studio, MCP tool calls and a Node host client-SDK port', async () => {
    const { ctx, events } = makeCtx();
    const studio = await callersOf(events, () =>
      send(ctx, fakePort(), { t: 'op', method: 'rtdb.set', path: '/studio', value: 1, issuer: 'studio', actAs: { mode: 'admin' } }));
    expect(studio).toContainEqual({ kind: 'studio' });
    const mcp = await callersOf(events, () =>
      send(ctx, fakePort(), { t: 'tool', name: 'firestore_create_document', args: { path: 'notes/from-agent', data: { text: 'agent' } } }));
    expect(mcp.length).toBeGreaterThan(0);
    for (const caller of mcp) expect(caller).toEqual({ kind: 'mcp' });
    const server = fakePort();
    markPortConnection(ctx, server, 'node');
    const node = await callersOf(events, () => send(ctx, server, { t: 'op', method: 'rtdb.set', path: '/server/client', value: 1 }));
    expect(node).toContainEqual({ kind: 'node' });
    expect(await subscribedPageId(ctx, server)).toBeUndefined();
  });

  it('ignores a caller a frame names for itself', async () => {
    const { ctx, events } = makeCtx();
    const page = fakePort();
    const pageId = await subscribedPageId(ctx, page);
    const callers = await callersOf(events, () =>
      send(ctx, page, { t: 'op', method: 'rtdb.set', path: '/forged', value: 1, caller: { kind: 'admin' } }));
    for (const caller of callers) expect(caller).toEqual({ kind: 'page', pageId });
  });
});
