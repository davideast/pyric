/**
 * A number past the safe-integer range keeps its float type across the
 * worker bridge (#1781).
 *
 * The Firebase SDKs send a number that is not a safe integer as a
 * `doubleValue`, so production's rules read `2 ** 53` and `1e300` as floats.
 * A client write crosses the bridge as a plain JavaScript number, through a
 * MessagePort for a browser tab and through a JSON relay for a remote client
 * such as the Node host. Both keep the magnitude, and the host's rules type
 * the number by it, so `is float` holds and `is int` denies on both.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import * as client from '../../../src/serve/worker/client.js';
import { makeHostCtx, type FakePort } from './integration-support.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /floats/{id} {
      allow create: if request.resource.data.n is float
        && request.resource.data.n + 0 == request.resource.data.n;
      allow read: if resource.data.n is float;
    }
    match /ints/{id} {
      allow create: if request.resource.data.n is int;
    }
  }
}`;

type Relay = (message: unknown) => unknown;

const structured: Relay = (message) => structuredClone(message);
const json: Relay = (message) => JSON.parse(JSON.stringify(message));

/** A fake port pair that copies each message the way `relay` does. */
function relayedPortPair(relay: Relay): { a: FakePort; b: FakePort } {
  const a: FakePort = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {} };
  const b: FakePort = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {} };
  a.postMessage = (msg) => setTimeout(() => b.onmessage?.({ data: relay(msg) }), 0);
  b.postMessage = (msg) => setTimeout(() => a.onmessage?.({ data: relay(msg) }), 0);
  return { a, b };
}

async function connect(relay: Relay, url: string) {
  const ctx = await makeHostCtx();
  const { getFirestore: adminFirestore } = await import('pyric/sandbox/admin-firestore');
  adminFirestore(ctx.sandbox.withAuth(null)).setRules(RULES);
  const { a: clientPort, b: hostPort } = relayedPortPair(relay);
  const hostPortLike: PortLike = { postMessage: (message: OutboundMessage) => hostPort.postMessage(message) };
  hostPort.onmessage = (event) => {
    void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
  };
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port = clientPort;
    constructor(_url: unknown, _opts: unknown) {}
  };
  return client.getFirestore(url);
}

describe('worker bridge: a host number past 2^53 reads as a float in rules', () => {
  let restore: () => void;
  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restore = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; };
  });
  afterEach(() => restore());

  for (const [plane, relay] of [['MessagePort', structured], ['JSON relay', json]] as const) {
    for (const [name, value] of [['2^53', 2 ** 53], ['2^53 + 2', 2 ** 53 + 2], ['1e300', 1e300]] as const) {
      it(`over the ${plane}, ${name} is a float and not an int`, async () => {
        const db = await connect(relay, `worker://host-number-${plane}-${name}`);
        const floatDoc = client.doc(db, 'floats/a');
        await client.setDoc(floatDoc, { n: value });
        const snapshot = await client.getDoc(floatDoc);
        expect(snapshot.data()?.n).toBe(value);
        await expect(client.setDoc(client.doc(db, 'ints/a'), { n: value }))
          .rejects.toMatchObject({ code: 'permission-denied' });
      });
    }

    it(`over the ${plane}, the largest safe integer is still an int`, async () => {
      const db = await connect(relay, `worker://host-number-${plane}-safe`);
      await client.setDoc(client.doc(db, 'ints/a'), { n: Number.MAX_SAFE_INTEGER });
      await expect(client.setDoc(client.doc(db, 'floats/a'), { n: Number.MAX_SAFE_INTEGER }))
        .rejects.toMatchObject({ code: 'permission-denied' });
    });
  }
});
