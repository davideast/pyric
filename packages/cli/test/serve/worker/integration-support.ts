/** Shared harness for client↔host integration tests over asynchronous fake ports. */
import 'fake-indexeddb/auto';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { getFirestore as ipGetFirestore } from 'pyric/firestore';
import { getAuth as ipGetAuth } from 'pyric/auth';
import * as client from '../../../src/serve/worker/client.js';

const GATE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} {
      allow read: if request.auth != null && request.auth.uid == resource.data.uid;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.uid;
      allow update, delete: if request.auth != null && request.auth.uid == resource.data.uid;
    }
  }
}`;

/** One endpoint of a bidirectional fake MessagePort pair. */
export interface FakePort {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  start(): void;
  close(): void;
  addEventListener(type: string, fn: () => void): void;
}

/** Deliver messages to the opposite endpoint on a macrotask, like real ports. */
export function portPair(): { a: FakePort; b: FakePort } {
  const a: FakePort = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {} };
  const b: FakePort = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {} };
  a.postMessage = (msg) => setTimeout(() => b.onmessage?.({ data: msg }), 0);
  b.postMessage = (msg) => setTimeout(() => a.onmessage?.({ data: msg }), 0);
  return { a, b };
}

export async function makeHostCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: adm } = await import('pyric/sandbox/admin-firestore');
  adm(sandbox.withAuth(null)).setRules(GATE_RULES);
  await sandbox.enablePersistence({
    key: `int-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  ipGetAuth(sandbox);
  return {
    db: ipGetFirestore(sandbox),
    sandbox,
    subs: new Map(),
    sessionMode: 'LOCAL',
    sessionBackend: createMemoryBackend(),
  };
}

/** Wire a real client database handle to a real host over the fake port pair. */
export async function connectClient(): Promise<{
  ctx: HostCtx;
  db: ReturnType<typeof client.getFirestore>;
}> {
  const ctx = await makeHostCtx();
  const { db } = connectClientToHost(ctx, 'worker://test');
  return { ctx, db };
}

/** Attach one independent client/port to an existing host context. */
export function connectClientToHost(
  ctx: HostCtx,
  url: string,
): {
  db: ReturnType<typeof client.getFirestore>;
  hostPort: PortLike;
} {
  const { a: clientPort, b: hostPort } = portPair();
  const hostPortLike: PortLike = {
    postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
  };
  hostPort.onmessage = (event) => {
    void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
  };
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port = clientPort;
    constructor(_url: unknown, _opts: unknown) {}
  };
  return { db: client.getFirestore(url), hostPort: hostPortLike };
}

export const sleep = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
