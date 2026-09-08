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
import { getFirestore } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';

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
    setRules(sandbox, RULES);
    const dispatch = buildSandboxDispatcher(sandbox);

    // Agent acting as alice creates her own message: allowed.
    const r1 = await dispatch('mutate_sandbox_data', {
      service: 'firestore',
      action: 'set',
      path: 'rooms/r1/msgs/m1',
      dataJson: JSON.stringify({ author: 'alice', body: 'hi' }),
      auth: { mode: 'uid', uid: 'alice' },
    });
    expect(r1.ok).toBe(true);

    // Agent acting as bob, forging a message authored by alice: denied.
    const r2 = await dispatch('mutate_sandbox_data', {
      service: 'firestore',
      action: 'set',
      path: 'rooms/r1/msgs/m2',
      dataJson: JSON.stringify({ author: 'alice', body: 'forged' }),
      auth: { mode: 'uid', uid: 'bob' },
    });
    expect(r2.ok).toBe(false);

    // Agent acting as bob, his own message: allowed.
    const r3 = await dispatch('mutate_sandbox_data', {
      service: 'firestore',
      action: 'set',
      path: 'rooms/r1/msgs/m3',
      dataJson: JSON.stringify({ author: 'bob', body: 'hey' }),
      auth: { mode: 'uid', uid: 'bob' },
    });
    expect(r3.ok).toBe(true);

    // Agent acting as bob reads alice's message (read allowed for any signed-in user).
    const r4 = await dispatch('query_sandbox_data', {
      service: 'firestore',
      path: 'rooms/r1/msgs/m1',
      auth: { mode: 'uid', uid: 'bob' },
    });
    expect(r4.ok).toBe(true);
    expect((r4.data as { results: Array<{ data: unknown }> }).results[0].data).toEqual({ author: 'alice', body: 'hi' });

    // Custom claims ride the `auth` arg: a role:admin claim satisfies a token-gated rule.
    const r5 = await dispatch('mutate_sandbox_data', {
      service: 'firestore',
      action: 'set',
      path: 'admin/x',
      dataJson: JSON.stringify({ v: 1 }),
      auth: { mode: 'uid', uid: 'a', claimsJson: JSON.stringify({ role: 'admin' }) },
    });
    expect(r5.ok).toBe(true);

    // The same op without the claim is denied.
    const r5Denied = await dispatch('mutate_sandbox_data', {
      service: 'firestore',
      action: 'set',
      path: 'admin/y',
      dataJson: JSON.stringify({ v: 1 }),
      auth: { mode: 'uid', uid: 'b' },
    });
    expect(r5Denied.ok).toBe(false);

    // No `auth` (admin default) bypasses rules: seeding writes any author.
    const r6 = await dispatch('mutate_sandbox_data', {
      service: 'firestore',
      action: 'set',
      path: 'rooms/r1/msgs/seed',
      dataJson: JSON.stringify({ author: 'system' }),
    });
    expect(r6.ok).toBe(true);
  });
});
