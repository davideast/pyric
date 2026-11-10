import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { deployFirestoreRulesToHost } from '../../../src/serve/worker/host/rules.js';
import { liveCallValues } from '../../../src/serve/worker/host/observe.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage(message) { messages.push(message); } };
}

function makeCtx(): HostCtx {
  const sandbox = initializeSandbox();
  return { db: getFirestore(sandbox), sandbox, instanceId: 'observe-prototype-test', subs: new Map() };
}

describe('host: observed call prototype quarantine', () => {
  it('evaluates local Firestore rules cleanly when writeData carries an own __proto__ key', async () => {
    const ctx = makeCtx();
    deployFirestoreRulesToHost(
      ctx,
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow write: if request.resource.data.keys().hasAll(['__proto__', 'title'])
        && request.resource.data.size() == 2;
    }
  }
}`,
    );
    const port = fakePort();
    const rawCall = JSON.parse(
      JSON.stringify({
        service: 'firestore',
        method: 'setDoc',
        path: 'items/item-1',
        projectId: 'proj',
        at: 200,
        account: { uid: 'uid-1' },
        outcome: { status: 'ok' },
      }),
    ) as Record<string, unknown>;
    rawCall.writeData = JSON.parse('{"__proto__":{"toString":"not-callable","role":"member"},"title":"ok"}');

    await handleMessage(ctx, port, { t: 'observe', id: 'obs-proto', call: rawCall } as unknown as InboundMessage);
    const event = ctx.sandbox.history().find((entry) => entry.kind === 'operation' && entry.path === 'items/item-1');
    expect(event?.kind === 'operation' ? event.production?.local?.result : undefined).toBe('allow');

    for (const held of liveCallValues(ctx.sandbox).values()) {
      expect(() => String(held.writeData)).not.toThrow();
    }
  });
});
