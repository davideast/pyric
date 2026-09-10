/**
 * The sandbox clock, exercised through the service-tool surface: pinning and
 * advancing it moves what `serverTimestamp()` stamps, what `rules.simulate`
 * evaluates `request.time` and `now` against for every service, what a
 * minted auth token's `iat` reads, and what a checkpoint restores. Every
 * assertion here reads the sandbox's actual state, never the method's own
 * claim, which is the honesty invariant a clock method has to pass.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import { getAuth, getIdTokenResult, sandbox as authSandbox, signInWithEmailAndPassword } from 'pyric/auth';
import { serverTimestamp } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';

import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../src/bridge/surface/index.js';

const OPEN_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const surface = renderSurface(undefined);

function freshContext(): { ctx: SurfaceContext; sandbox: ReturnType<typeof initializeSandbox> } {
  const sandbox = initializeSandbox();
  setRules(sandbox, OPEN_FIRESTORE_RULES);
  const projectDir = mkdtempSync(join(tmpdir(), 'pyric-clock-'));
  return { ctx: createSurfaceContext(sandbox, projectDir), sandbox };
}

async function call(
  ctx: SurfaceContext,
  key: string,
  args: Record<string, unknown> = {},
): Promise<OperationResult> {
  const [toolName, method] = key.split('.');
  const tool = surface.tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) throw new Error(`no tool named ${toolName}`);
  return tool.execute({ method, args }, ctx);
}

describe('setClock pins a stamped write to the exact instant', () => {
  it('a serverTimestamp() field carries the pinned instant, not wallclock', async () => {
    const { ctx } = freshContext();
    const pinned = await call(ctx, 'sandbox.setClock', { isoTime: '2026-06-01T00:00:00.000Z' });
    expect(pinned.ok).toBe(true);

    const written = await call(ctx, 'firestore.setDoc', {
      path: 'notes/pinned',
      data: { createdAt: serverTimestamp() },
    });
    expect(written.ok).toBe(true);

    const read = await call(ctx, 'firestore.getDoc', { path: 'notes/pinned' });
    const stamp = (read.data as { data: { createdAt: { seconds: number } } }).data.createdAt;
    expect(stamp.seconds).toBe(Date.parse('2026-06-01T00:00:00.000Z') / 1000);
  });
});

describe('rules.simulate flips a request.time-gated rule for every service, driven by setClock', () => {
  it('firestore', async () => {
    const { ctx } = freshContext();
    const gated = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.time > timestamp.date(2026, 1, 1);
    }
  }
}`;
    await call(ctx, 'rules.set', { service: 'firestore', rules: gated });

    await call(ctx, 'sandbox.setClock', { isoTime: '2025-12-31T00:00:00.000Z' });
    const before = await call(ctx, 'rules.simulate', {
      service: 'firestore',
      operation: 'get',
      path: 'notes/n1',
    });
    expect((before.data as { allowed: boolean }).allowed).toBe(false);

    await call(ctx, 'sandbox.setClock', { isoTime: '2026-02-01T00:00:00.000Z' });
    const after = await call(ctx, 'rules.simulate', {
      service: 'firestore',
      operation: 'get',
      path: 'notes/n1',
    });
    expect((after.data as { allowed: boolean }).allowed).toBe(true);
  });

  it('database', async () => {
    const { ctx } = freshContext();
    const gateInstant = Date.parse('2026-01-01T00:00:00.000Z');
    const gated = JSON.stringify({ rules: { '.read': `now > ${gateInstant}` } });
    await call(ctx, 'rules.set', { service: 'database', rules: gated });

    await call(ctx, 'sandbox.setClock', { isoTime: '2025-12-31T00:00:00.000Z' });
    const before = await call(ctx, 'rules.simulate', {
      service: 'database',
      operation: 'read',
      path: 'rooms/lobby',
    });
    expect((before.data as { allowed: boolean }).allowed).toBe(false);

    await call(ctx, 'sandbox.setClock', { isoTime: '2026-02-01T00:00:00.000Z' });
    const after = await call(ctx, 'rules.simulate', {
      service: 'database',
      operation: 'read',
      path: 'rooms/lobby',
    });
    expect((after.data as { allowed: boolean }).allowed).toBe(true);
  });

  it('storage', async () => {
    const { ctx } = freshContext();
    const gated = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.time > timestamp.date(2026, 1, 1);
    }
  }
}`;
    await call(ctx, 'rules.set', { service: 'storage', rules: gated });

    await call(ctx, 'sandbox.setClock', { isoTime: '2025-12-31T00:00:00.000Z' });
    const before = await call(ctx, 'rules.simulate', {
      service: 'storage',
      operation: 'get',
      path: 'uploads/note.txt',
    });
    expect((before.data as { allowed: boolean }).allowed).toBe(false);

    await call(ctx, 'sandbox.setClock', { isoTime: '2026-02-01T00:00:00.000Z' });
    const after = await call(ctx, 'rules.simulate', {
      service: 'storage',
      operation: 'get',
      path: 'uploads/note.txt',
    });
    expect((after.data as { allowed: boolean }).allowed).toBe(true);
  });
});

describe('a minted token follows the clock', () => {
  it('a signed-in user’s iat is the pinned instant', async () => {
    const { ctx, sandbox } = freshContext();
    await call(ctx, 'auth.createUser', {
      uid: 'clock-holder',
      email: 'holder@example.com',
      password: 'super-secret-1',
    });
    authSandbox.seedUsers(getAuth(sandbox), [
      { uid: 'clock-holder', email: 'holder@example.com', password: 'super-secret-1' },
    ]);

    await call(ctx, 'sandbox.setClock', { isoTime: '2026-03-01T00:00:00.000Z' });
    const signedIn = await signInWithEmailAndPassword(
      getAuth(sandbox),
      'holder@example.com',
      'super-secret-1',
    );
    const token = await getIdTokenResult(signedIn.user);
    expect(token.claims['iat']).toBe(Math.floor(Date.parse('2026-03-01T00:00:00.000Z') / 1000));
  });
});

describe('advanceClock', () => {
  it('stays frozen at the new instant under a pinned clock', async () => {
    const { ctx } = freshContext();
    await call(ctx, 'sandbox.setClock', { isoTime: '2026-01-01T00:00:00.000Z' });
    await call(ctx, 'sandbox.advanceClock', { ms: 60_000 });
    const first = await call(ctx, 'sandbox.inspect');
    const second = await call(ctx, 'sandbox.inspect');
    expect((first.data as { clock: { now: number } }).clock.now).toBe(
      (second.data as { clock: { now: number } }).clock.now,
    );
    expect((first.data as { clock: { now: number } }).clock.now).toBe(
      Date.parse('2026-01-01T00:00:00.000Z') + 60_000,
    );
  });

  it('reports how far it shifted the wall clock', async () => {
    const { ctx } = freshContext();
    await call(ctx, 'sandbox.advanceClock', { ms: 3_600_000 });
    const inspected = await call(ctx, 'sandbox.inspect');
    const clock = (inspected.data as { clock: { mode: string; offsetMs?: number } }).clock;
    expect(clock.mode).toBe('offset');
    expect(clock.offsetMs).toBe(3_600_000);
  });

  it('reports no offset while the clock is pinned', async () => {
    const { ctx } = freshContext();
    await call(ctx, 'sandbox.setClock', { isoTime: '2026-01-01T00:00:00.000Z' });
    const inspected = await call(ctx, 'sandbox.inspect');
    const clock = (inspected.data as { clock: { mode: string; offsetMs?: number } }).clock;
    expect(clock.mode).toBe('fixed');
    expect(clock.offsetMs).toBeUndefined();
  });

  it('keeps flowing under the wall clock', async () => {
    const { ctx } = freshContext();
    await call(ctx, 'sandbox.advanceClock', { ms: 60_000 });
    const first = await call(ctx, 'sandbox.inspect');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await call(ctx, 'sandbox.inspect');
    expect((second.data as { clock: { now: number } }).clock.now).toBeGreaterThan(
      (first.data as { clock: { now: number } }).clock.now,
    );
  });
});

describe('resetClock', () => {
  it('returns inspect to wall mode within a second of real time', async () => {
    const { ctx } = freshContext();
    await call(ctx, 'sandbox.setClock', { isoTime: '2020-01-01T00:00:00.000Z' });
    await call(ctx, 'sandbox.resetClock');
    const inspected = await call(ctx, 'sandbox.inspect');
    const clock = (inspected.data as { clock: { mode: string; now: number } }).clock;
    expect(clock.mode).toBe('wall');
    expect(Math.abs(clock.now - Date.now())).toBeLessThan(1000);
  });
});

describe('rules.simulate(requestTime) leaves the sandbox clock untouched', () => {
  it('inspect reports the same clock before and after', async () => {
    const { ctx } = freshContext();
    await call(ctx, 'sandbox.setClock', { isoTime: '2026-01-01T00:00:00.000Z' });
    const before = await call(ctx, 'sandbox.inspect');
    await call(ctx, 'rules.simulate', {
      service: 'firestore',
      operation: 'get',
      path: 'notes/n1',
      requestTime: '2030-01-01T00:00:00.000Z',
    });
    const after = await call(ctx, 'sandbox.inspect');
    expect((after.data as { clock: unknown }).clock).toEqual(
      (before.data as { clock: unknown }).clock,
    );
  });
});

const GATED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /promo/{id} {
      allow read: if request.time < timestamp.date(2028, 1, 1);
    }
  }
}`;

interface BatchVerdict {
  allowed: boolean;
}

describe('rules.simulate cases evaluate at their own instant', () => {
  it('a case names its instant, else the call names it, else the clock', async () => {
    const { ctx } = freshContext();
    await call(ctx, 'sandbox.setClock', { isoTime: '2026-01-01T00:00:00.000Z' });
    const answered = await call(ctx, 'rules.simulate', {
      service: 'firestore',
      rules: GATED_RULES,
      requestTime: '2029-01-01T00:00:00.000Z',
      cases: [
        { operation: 'get', path: 'promo/p1', requestTime: '2027-06-01T00:00:00.000Z' },
        { operation: 'get', path: 'promo/p1' },
      ],
    });
    expect(answered.ok).toBe(true);
    const verdicts = (answered.data as { cases: BatchVerdict[] }).cases;
    expect(verdicts.map((one) => one.allowed)).toEqual([true, false]);

    const fromClock = await call(ctx, 'rules.simulate', {
      service: 'firestore',
      rules: GATED_RULES,
      cases: [{ operation: 'get', path: 'promo/p1' }],
    });
    expect((fromClock.data as { cases: BatchVerdict[] }).cases[0]?.allowed).toBe(true);
  });

  it('refuses a case whose instant does not parse', async () => {
    const { ctx } = freshContext();
    const refused = await call(ctx, 'rules.simulate', {
      service: 'firestore',
      cases: [{ operation: 'get', path: 'promo/p1', requestTime: 'next tuesday' }],
    });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('next tuesday');
  });
});

describe('a checkpoint taken under a pinned clock restores that clock', () => {
  it('checkpoint, resetClock, restore, inspect', async () => {
    const { ctx } = freshContext();
    await call(ctx, 'sandbox.setClock', { isoTime: '2026-04-01T00:00:00.000Z' });
    await call(ctx, 'sandbox.checkpoint', { name: 'pinned' });
    await call(ctx, 'sandbox.resetClock');

    const afterReset = await call(ctx, 'sandbox.inspect');
    expect((afterReset.data as { clock: { mode: string } }).clock.mode).toBe('wall');

    await call(ctx, 'sandbox.restore', { name: 'pinned', confirm: true });
    const restored = await call(ctx, 'sandbox.inspect');
    const clock = (restored.data as { clock: { mode: string; now: number } }).clock;
    expect(clock.mode).toBe('fixed');
    expect(clock.now).toBe(Date.parse('2026-04-01T00:00:00.000Z'));
  });
});

describe('the clock is an experiment control, not data a branch lands', () => {
  it('promote leaves live on the clock it already had', async () => {
    const { ctx } = freshContext();
    await call(ctx, 'sandbox.fork', { branch: 'experiment' });
    await call(ctx, 'sandbox.setClock', { isoTime: '2026-07-01T00:00:00.000Z' });
    const before = await call(ctx, 'sandbox.inspect');

    await call(ctx, 'sandbox.promote', { branch: 'experiment', confirm: true });

    const after = await call(ctx, 'sandbox.inspect');
    expect((after.data as { clock: unknown }).clock).toEqual(
      (before.data as { clock: unknown }).clock,
    );
  });

  it('diff reports nothing for a branch that only moved its clock', async () => {
    const { ctx } = freshContext();
    await call(ctx, 'sandbox.fork', { branch: 'later' });
    await call(ctx, 'sandbox.setClock', { isoTime: '2026-08-01T00:00:00.000Z' });

    const reported = await call(ctx, 'sandbox.diff', { branch: 'later' });

    expect((reported.data as { divergences: unknown[] }).divergences).toEqual([]);
  });
});

describe('a read leaves the clock, and the snapshot, exactly as it found them', () => {
  it('inspect does not change getClock’s own report', async () => {
    const { ctx, sandbox } = freshContext();
    await call(ctx, 'sandbox.setClock', { isoTime: '2026-05-01T00:00:00.000Z' });
    const before = getClock(sandbox).now();
    await call(ctx, 'sandbox.inspect');
    const after = getClock(sandbox).now();
    expect(after).toBe(before);
  });
});
