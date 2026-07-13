/**
 * Multi-user over the SharedWorker host: cross-identity fan-out (Slice C of
 * design rationale).
 *
 * The per-op + per-sub `actAs` lens is already covered (auth-lens / sub-lens /
 * security-per-user). This pins the HEADLINE multi-user-sync scenario in served
 * mode: client A writes AS alice, and client B's ACTIVE `onSnapshot` AS bob
 * receives it, across two distinct identities over one shared sandbox.
 */
import { describe, it, expect } from 'bun:test';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { OutboundMessage, SnapMessage } from '../../../src/serve/worker/protocol.js';
import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth } from 'pyric/auth';

// Any signed-in identity reads + writes, so bob can see alice's write.
const AUTHED_RW = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`;

function fakePort(): PortLike & { snaps: SnapMessage[] } {
  const snaps: SnapMessage[] = [];
  return {
    snaps,
    postMessage(msg: OutboundMessage) {
      if (msg.t === 'snap') snaps.push(msg);
    },
  };
}
type FakePort = ReturnType<typeof fakePort>;

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(AUTHED_RW);
  await sandbox.enablePersistence({
    key: `mu-fanout-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  getAuth(sandbox);
  return { db: getFirestore(sandbox), sandbox, subs: new Map(), sessionMode: 'LOCAL' };
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
let _seq = 0;
const opId = (): string => `mu-fanout-${++_seq}`;

interface SnapVal {
  exists?: boolean;
  data?: { json: string };
  __error?: { code: string; message: string };
}
function lastSnap(port: FakePort, subId: string): SnapVal {
  const s = port.snaps.filter((m) => m.subId === subId).at(-1);
  if (!s) throw new Error(`No snap for ${subId}`);
  return (s.value ?? {}) as SnapVal;
}

describe('multi-user over the worker — cross-identity fan-out (Slice C)', () => {
  it("a write as alice reaches bob's active onSnapshot (as bob) on the shared store", async () => {
    const ctx = await makeCtx();
    const portA = fakePort(); // client A acts as alice
    const portB = fakePort(); // client B acts as bob

    // B opens a live doc subscription AS bob.
    await handleMessage(ctx, portB, {
      t: 'sub',
      subId: 'B_WATCH',
      target: { __ref: 'doc', path: 'shared/x' },
      actAs: { mode: 'as', uid: 'bob' },
    });
    await tick();

    // A writes the doc AS alice.
    await handleMessage(ctx, portA, {
      t: 'op',
      id: opId(),
      method: 'setDoc',
      path: 'shared/x',
      data: { by: 'alice', n: 1 },
      actAs: { mode: 'as', uid: 'alice' },
    });
    await tick();

    // B's listener (as bob) received alice's write: cross-identity fan-out across
    // two distinct identities over one shared sandbox, in served mode.
    const val = lastSnap(portB, 'B_WATCH');
    expect(val.__error).toBeUndefined();
    expect(val.exists).toBe(true);
    expect(JSON.parse(val.data!.json)).toEqual({ by: 'alice', n: 1 });
  });
});
