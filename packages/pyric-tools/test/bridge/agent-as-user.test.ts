/**
 * Agent-as-a-distinct-user (Slice D of design rationale).
 *
 * The agent's firestore tools already expose an `as` arg (firestore/tools.ts
 * AS_SCHEMA): `{ uid, claims? }` runs the op AS that user with rules ENFORCED;
 * omitted / `'admin'` bypasses rules (seeding). This pins the headline at the
 * agent's REAL interface, `buildSandboxDispatcher`: the agent acts as distinct
 * users with rules enforced (so it can sit alongside a human as another user),
 * custom claims ride the lens, and admin-seeding still bypasses.
 */
import { describe, it, expect } from 'bun:test';
import { buildSandboxDispatcher } from '../../src/bridge/client/dispatch.js';
import { initializeSandbox } from 'pyric/sandbox';
import { sandbox as sandboxOps, getFirestore } from 'pyric/firestore';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /rooms/{room}/msgs/{msg} {
      allow read: if request.auth != null;
      allow write: if request.auth != null
        && request.auth.uid == request.resource.data.author;
    }
    match /admin/{doc} {
      allow write: if request.auth != null && request.auth.token.role == 'admin';
    }
  }
}`;

describe('agent-as-a-distinct-user via the tool dispatcher (Slice D)', () => {
  it('acts as distinct users with rules enforced; claims flow; admin bypasses', async () => {
    const sandbox = initializeSandbox();
    sandboxOps.setRules(getFirestore(sandbox), RULES);
    const dispatch = buildSandboxDispatcher(sandbox);

    // Agent acting as alice creates her own message: allowed.
    const r1 = await dispatch('firestore_create_document', {
      path: 'rooms/r1/msgs/m1',
      data: { author: 'alice', body: 'hi' },
      as: { uid: 'alice' },
    });
    expect(r1.ok).toBe(true);

    // Agent acting as bob, forging a message authored by alice: denied.
    await expect(
      dispatch('firestore_create_document', {
        path: 'rooms/r1/msgs/m2',
        data: { author: 'alice', body: 'forged' },
        as: { uid: 'bob' },
      }),
    ).rejects.toThrow();

    // Agent acting as bob, his own message: allowed.
    const r3 = await dispatch('firestore_create_document', {
      path: 'rooms/r1/msgs/m3',
      data: { author: 'bob', body: 'hey' },
      as: { uid: 'bob' },
    });
    expect(r3.ok).toBe(true);

    // Agent acting as bob reads alice's message (read allowed for any signed-in user).
    const r4 = await dispatch('firestore_get_document', {
      path: 'rooms/r1/msgs/m1',
      as: { uid: 'bob' },
    });
    expect(r4.ok).toBe(true);
    expect((r4.data as { data: unknown }).data).toEqual({ author: 'alice', body: 'hi' });

    // Custom claims ride the `as` arg: a role:admin claim satisfies a token-gated rule.
    const r5 = await dispatch('firestore_create_document', {
      path: 'admin/x',
      data: { v: 1 },
      as: { uid: 'a', claims: { role: 'admin' } },
    });
    expect(r5.ok).toBe(true);

    // The same op without the claim is denied.
    await expect(
      dispatch('firestore_create_document', {
        path: 'admin/y',
        data: { v: 1 },
        as: { uid: 'b' },
      }),
    ).rejects.toThrow();

    // No `as` (admin default) bypasses rules: seeding writes any author.
    const r6 = await dispatch('firestore_create_document', {
      path: 'rooms/r1/msgs/seed',
      data: { author: 'system' },
    });
    expect(r6.ok).toBe(true);
  });
});
