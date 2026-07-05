/**
 * Multi-user (programmatic) — Slice A/B of design rationale
 *
 * One sandbox, multiple identities via `actingAs(sandbox, { uid })`. Proves the
 * two claims a single-identity sandbox can't: (A) a write by one identity is
 * delivered to another identity's `onSnapshot` (shared store, cross-identity
 * fan-out), and (B) security rules evaluate per identity (`request.auth.uid`).
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  actingAs,
  doc,
  setDoc,
  onSnapshot,
  sandbox as sandboxOps,
  type DocumentSnapshot,
} from '../../src/firestore/index.js';

const PERMISSIVE = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

// Owner-write: any signed-in user reads; only the doc's declared author may write.
const OWNER_WRITE = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /rooms/{room}/msgs/{msg} {
      allow read: if request.auth != null;
      allow write: if request.auth != null
        && request.auth.uid == request.resource.data.author;
    }
  }
}`;

describe('multi-user (programmatic): one sandbox, distinct identities', () => {
  it('a write by one identity reaches another identity onSnapshot (shared store)', async () => {
    const sandbox = initializeSandbox();
    const alice = actingAs(sandbox, { uid: 'alice' });
    const bob = actingAs(sandbox, { uid: 'bob' });
    sandboxOps.setRules(alice, PERMISSIVE);

    const seen: Array<Record<string, unknown> | undefined> = [];
    const unsub = onSnapshot(doc(bob, 'rooms/r1'), (snap: DocumentSnapshot) => {
      seen.push(snap.data() as Record<string, unknown> | undefined);
    });

    await setDoc(doc(alice, 'rooms/r1'), { owner: 'alice', n: 1 });

    // Bob's listener received Alice's write: cross-identity fan-out on one store.
    expect(seen.at(-1)).toEqual({ owner: 'alice', n: 1 });
    unsub();
  });

  it('rules evaluate per identity: bob cannot forge a message authored by alice', async () => {
    const sandbox = initializeSandbox();
    const alice = actingAs(sandbox, { uid: 'alice' });
    const bob = actingAs(sandbox, { uid: 'bob' });
    sandboxOps.setRules(alice, OWNER_WRITE);

    // Alice writes her own message — allowed.
    await expect(
      setDoc(doc(alice, 'rooms/r1/msgs/m1'), { author: 'alice', body: 'hi' }),
    ).resolves.toBeUndefined();

    // Bob writing a message authored by alice — denied (request.auth.uid is bob).
    await expect(
      setDoc(doc(bob, 'rooms/r1/msgs/m2'), { author: 'alice', body: 'forged' }),
    ).rejects.toThrow();

    // Bob writing his own message — allowed.
    await expect(
      setDoc(doc(bob, 'rooms/r1/msgs/m3'), { author: 'bob', body: 'hey' }),
    ).resolves.toBeUndefined();
  });

  it('the anonymous identity (withAuth null) is denied by an auth-gated rule', async () => {
    const sandbox = initializeSandbox();
    const anon = actingAs(sandbox, null);
    sandboxOps.setRules(anon, PERMISSIVE);
    await expect(setDoc(doc(anon, 'rooms/r2'), { x: 1 })).rejects.toThrow();
  });
});
