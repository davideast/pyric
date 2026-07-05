/**
 * Listener-registry semantics — sandbox target. Locks AUTH-B3 + AUTH-B4.
 *
 * Upstream backs each observer registry with an ARRAY
 * (`util/src/subscribe.ts:191` pushes; `:198` `unsubscribeOne(i)` deletes
 * by index) and schedules a per-registration initial fire
 * (`auth_impl.ts:728-742`). So:
 *   - resubscribing the SAME fn fires the initial value again (the old
 *     shared per-observer `lastDelivered` WeakMap suppressed it → 0 fires);
 *   - the SAME fn registered on two listeners fires TWICE (Set collapsed
 *     it to one registration);
 *   - one unsubscribe removes exactly ONE registration (Set-delete killed
 *     every registration of that fn).
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  onAuthStateChanged,
  onIdTokenChanged,
  signInAnonymously,
  type User,
} from '../../src/auth/index.js';

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('listener registry (AUTH-B3 / AUTH-B4)', () => {
  it('AUTH-B3: resubscribing the same fn fires the initial value again', async () => {
    const auth = getAuth(initializeSandbox());
    let count = 0;
    const fn = (_u: User | null) => { count++; };
    const unsub = onAuthStateChanged(auth, fn);
    await flush();
    expect(count).toBe(1); // first initial fire
    unsub();
    onAuthStateChanged(auth, fn); // resubscribe the SAME fn
    await flush();
    expect(count).toBe(2); // second initial fire — NOT suppressed
  });

  it('AUTH-B4: same fn on two listeners both fire on initial + on change', async () => {
    const auth = getAuth(initializeSandbox());
    let count = 0;
    const fn = (_u: User | null) => { count++; };
    onAuthStateChanged(auth, fn);
    onAuthStateChanged(auth, fn); // duplicate registration
    await flush();
    expect(count).toBe(2); // two independent initial fires
    await signInAnonymously(auth);
    await flush();
    expect(count).toBe(4); // both fire on the sign-in too
  });

  it('AUTH-B4: one unsubscribe removes exactly one registration', async () => {
    const auth = getAuth(initializeSandbox());
    let count = 0;
    const fn = (_u: User | null) => { count++; };
    const unsubA = onAuthStateChanged(auth, fn);
    onAuthStateChanged(auth, fn); // second registration of same fn
    await flush();
    expect(count).toBe(2);
    unsubA(); // remove only the first registration
    await signInAnonymously(auth);
    await flush();
    expect(count).toBe(3); // the surviving registration still fires once
  });

  it('AUTH-B3: same fn across auth-state AND id-token registries both fire', async () => {
    const auth = getAuth(initializeSandbox());
    let count = 0;
    const fn = (_u: User | null) => { count++; };
    onAuthStateChanged(auth, fn);
    onIdTokenChanged(auth, fn); // same fn, different registry
    await flush();
    expect(count).toBe(2); // each registry delivers its own initial fire
  });
});
