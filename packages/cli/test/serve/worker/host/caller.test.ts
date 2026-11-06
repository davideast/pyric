/**
 * Every event a host emits names the connection that sent its operation.
 *
 * Both hosts call `handleMessage`, so these cases run once for the
 * SharedWorker and the Node host: a page's own Firestore, RTDB and Storage
 * calls carry that page's id, a second page carries another, a bridge relay is
 * admin code, a tool frame is an MCP call, a Studio frame is Studio's, and a
 * port the Node host admitted for a server process using the client SDK is
 * `node`. A port whose `appConfig` declares the service worker realm is
 * `service-worker`, and Messaging's own hello names a page by its tab id.
 * Each page's event subscription hands it its own id.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, toOperationRecord, type EventCaller, type SandboxEvent } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import { markPortConnection, SERVICE_WORKER_TAB_ID } from '../../../../src/serve/worker/host/caller.js';
import { pageTabId } from '../../../../src/serve/worker/client/tab-id.js';
import { messagingAppConfig } from '../../../../src/serve/entries/messaging-sw-client.js';
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

/** Runs `run` with the globals `isServiceWorkerRealm` reads, as a service worker has them. */
function inServiceWorkerRealm<T>(run: () => T): T {
  const scope = globalThis as { registration?: unknown; clients?: unknown };
  scope.registration = {};
  scope.clients = {};
  try {
    return run();
  } finally {
    delete scope.registration;
    delete scope.clients;
  }
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

  it("names a page's Messaging port by the page's tab id", async () => {
    const { ctx, events } = makeCtx();
    const messaging = fakePort();
    // The hello the sandbox's Messaging client sends from a page (`messaging-sw-client.ts`).
    await handleMessage(ctx, messaging, messagingAppConfig({ projectId: 'demo-app' }));
    const callers = await callersOf(events, () => send(ctx, messaging, { t: 'op', method: 'rtdb.set', path: '/messaging/page', value: 1 }));
    expect(callers.length).toBeGreaterThan(0);
    for (const caller of callers) expect(caller).toEqual({ kind: 'page', pageId: pageTabId() });
  });

  it('stamps a port whose appConfig declares the service worker realm as the service worker', async () => {
    const { ctx, events } = makeCtx();
    const serviceWorker = fakePort();
    // The hello the sandbox's Messaging service worker sends (`messaging-sw-client.ts`).
    const hello = inServiceWorkerRealm(() => messagingAppConfig({ projectId: 'demo-app' }));
    expect(hello.tabId).toBe(SERVICE_WORKER_TAB_ID);
    await handleMessage(ctx, serviceWorker, hello);
    const callers = await callersOf(events, () => send(ctx, serviceWorker, { t: 'op', method: 'rtdb.set', path: '/sw/a', value: 1 }));
    expect(callers.length).toBeGreaterThan(0);
    for (const caller of callers) expect(caller).toEqual({ kind: 'service-worker' });
    expect(await subscribedPageId(ctx, serviceWorker)).toBeUndefined();
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
    expect(node).toContainEqual({ kind: 'node', clientId: expect.any(String) });
    expect(await subscribedPageId(ctx, server)).toBeUndefined();
  });

  it("stamps one client id on every tab of a browser profile, and another on a second profile", async () => {
    const { ctx, events } = makeCtx();
    const firstTab = fakePort();
    const secondTab = fakePort();
    const otherProfile = fakePort();
    await handleMessage(ctx, firstTab, { t: 'appConfig', options: { projectId: 'demo-app' }, tabId: 'tab-a1', clientId: 'profile-a' } as InboundMessage);
    await handleMessage(ctx, secondTab, { t: 'appConfig', options: { projectId: 'demo-app' }, tabId: 'tab-a2', clientId: 'profile-a' } as InboundMessage);
    await handleMessage(ctx, otherProfile, { t: 'appConfig', options: { projectId: 'demo-app' }, tabId: 'tab-b1', clientId: 'profile-b' } as InboundMessage);
    const first = await callersOf(events, () => send(ctx, firstTab, { t: 'op', method: 'rtdb.set', path: '/clients/a1', value: 1 }));
    const second = await callersOf(events, () => send(ctx, secondTab, { t: 'op', method: 'setDoc', path: 'clients/a2', data: { n: 1 } }));
    const other = await callersOf(events, () => send(ctx, otherProfile, { t: 'op', method: 'rtdb.set', path: '/clients/b1', value: 1 }));
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(other.length).toBeGreaterThan(0);
    for (const caller of first) expect(caller).toEqual({ kind: 'page', pageId: 'tab-a1', clientId: 'profile-a' });
    for (const caller of second) expect(caller).toEqual({ kind: 'page', pageId: 'tab-a2', clientId: 'profile-a' });
    for (const caller of other) expect(caller).toEqual({ kind: 'page', pageId: 'tab-b1', clientId: 'profile-b' });
  });

  it("stamps a service worker's declared client id", async () => {
    const { ctx, events } = makeCtx();
    const serviceWorker = fakePort();
    await handleMessage(ctx, serviceWorker, { t: 'appConfig', options: { projectId: 'demo-app' }, tabId: SERVICE_WORKER_TAB_ID, clientId: 'sw-realm-1' } as InboundMessage);
    const callers = await callersOf(events, () => send(ctx, serviceWorker, { t: 'op', method: 'rtdb.set', path: '/sw/client', value: 1 }));
    expect(callers.length).toBeGreaterThan(0);
    for (const caller of callers) expect(caller).toEqual({ kind: 'service-worker', clientId: 'sw-realm-1' });
  });

  it('gives each Node host socket its own client id, whatever its appConfig declares', async () => {
    const { ctx, events } = makeCtx();
    const firstProcess = fakePort();
    const secondProcess = fakePort();
    markPortConnection(ctx, firstProcess, 'node');
    markPortConnection(ctx, secondProcess, 'node');
    await handleMessage(ctx, firstProcess, { t: 'appConfig', options: { projectId: 'demo-app' }, clientId: 'claimed' } as InboundMessage);
    await handleMessage(ctx, secondProcess, { t: 'appConfig', options: { projectId: 'demo-app' }, clientId: 'claimed' } as InboundMessage);
    const first = await callersOf(events, () => send(ctx, firstProcess, { t: 'op', method: 'rtdb.set', path: '/node/one', value: 1 }));
    const second = await callersOf(events, () => send(ctx, secondProcess, { t: 'op', method: 'rtdb.set', path: '/node/two', value: 1 }));
    const firstIds = new Set(first.map((caller) => caller?.clientId));
    const secondIds = new Set(second.map((caller) => caller?.clientId));
    expect(firstIds.size).toBe(1);
    expect(secondIds.size).toBe(1);
    const [firstId] = firstIds;
    const [secondId] = secondIds;
    expect(firstId).toBeString();
    expect(secondId).toBeString();
    expect(firstId).not.toBe(secondId);
    expect(firstId).not.toBe('claimed');
    for (const caller of first) expect(caller?.kind).toBe('node');
  });

  it('keeps no client id a page declares longer than 64 characters, and stamps none on relays, MCP or Studio', async () => {
    const { ctx, events } = makeCtx();
    const page = fakePort();
    await handleMessage(ctx, page, { t: 'appConfig', options: { projectId: 'demo-app' }, tabId: 'tab-long', clientId: 'x'.repeat(65) } as InboundMessage);
    const long = await callersOf(events, () => send(ctx, page, { t: 'op', method: 'rtdb.set', path: '/long', value: 1 }));
    for (const caller of long) expect(caller).toEqual({ kind: 'page', pageId: 'tab-long' });
    const others = await callersOf(events, async () => {
      await send(ctx, page, { t: 'op', method: 'rtdb.set', path: '/relay', value: 1, actAs: { mode: 'admin' }, relaySource: 'remote' });
      await send(ctx, page, { t: 'op', method: 'rtdb.set', path: '/studio', value: 1, issuer: 'studio', actAs: { mode: 'admin' } });
      await send(ctx, page, { t: 'tool', name: 'firestore_create_document', args: { path: 'notes/agent', data: { text: 'agent' } } });
    });
    expect(others.length).toBeGreaterThan(0);
    for (const caller of others) expect(caller?.clientId).toBeUndefined();
  });

  it('refuses an appConfig whose client id is not a string', async () => {
    const { ctx } = makeCtx();
    const page = fakePort();
    await handleMessage(ctx, page, { t: 'appConfig', id: 'bad-client-id', options: { projectId: 'demo-app' }, clientId: 42 } as unknown as InboundMessage);
    const refusal = page.messages.find((message) => message.t === 'res' && message.id === 'bad-client-id');
    expect(refusal?.t === 'res' && !refusal.ok ? refusal.error.code : undefined).toBe('invalid-argument');
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
