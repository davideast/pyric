/**
 * Tests for the Pyric Studio event-unification keystone (track T1):
 * every event on the unified `onEvent`/`history()` stream carries
 * {@link EventProvenance}, stamped in ONE place
 * ({@link stampProvenance} / {@link SandboxImpl.emitEvent}).
 *
 * Today Firestore is the only emitter, so the assertions here cover the
 * Firestore path + the sandbox-level lifecycle events (session_boundary)
 * defaulting correctly, plus the reserved `emitSandboxEvent` seam that
 * Auth/Storage/RTDB will call once they construct events.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import {
  getInternalEnv,
  emitSandboxEvent,
  stampProvenance,
} from '../../src/sandbox/internal/sandbox-impl.js';
import type { SandboxEvent } from '../../src/sandbox/index.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if request.auth.uid == 'alice';
    }
  }
}`;

function makeSandbox() {
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  env.seed({ rules: RULES });
  return { sandbox, env };
}

describe('event provenance (Studio T1 keystone)', () => {
  it('stamps firestore/unattributed/app-session defaults on every Firestore event', () => {
    const { sandbox, env } = makeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    env.execute({ method: 'set', path: 'notes/n1', auth: { uid: 'alice' }, data: { body: 'hi' } });

    // A set produces at least a request + a write event; both must be stamped.
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.service).toBe('firestore');
      expect(e.actor).toEqual({ kind: 'unattributed' });
      expect(e.authLens).toEqual({ mode: 'app-session' });
      expect(e.planId).toBeUndefined();
    }
  });

  it('stamps history() entries too (not just the live stream)', () => {
    const { sandbox, env } = makeSandbox();
    env.execute({ method: 'set', path: 'notes/n1', auth: { uid: 'alice' }, data: { body: 'hi' } });

    const history = sandbox.history();
    expect(history.length).toBeGreaterThan(0);
    for (const e of history) {
      expect(e.service).toBe('firestore');
      expect(e.actor).toEqual({ kind: 'unattributed' });
      expect(e.authLens).toEqual({ mode: 'app-session' });
    }
  });

  it('stamps sandbox-level lifecycle events (session_boundary)', () => {
    const { sandbox } = makeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    sandbox.reset();

    const boundary = events.find((e) => e.kind === 'session_boundary');
    expect(boundary).toBeDefined();
    expect(boundary!.service).toBe('firestore');
    expect(boundary!.actor).toEqual({ kind: 'unattributed' });
    expect(boundary!.authLens).toEqual({ mode: 'app-session' });
  });

  it('emitSandboxEvent applies provenance overrides (the non-Firestore seam)', () => {
    const { sandbox } = makeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    // Simulate a future Auth emitter landing an event on the unified stream.
    // (The event SHAPE here is a stand-in — the real per-service shapes are
    // follow-up work; this exercises the stamping + dispatch seam only.)
    const authEvent = {
      kind: 'session_boundary' as const,
      id: 'evt-auth-1',
      at: Date.now(),
      phase: 'dispose' as const,
      priorOpCount: 0,
    };
    emitSandboxEvent(sandbox, authEvent, {
      service: 'auth',
      actor: { kind: 'studio' },
      authLens: { mode: 'admin' },
      planId: 'plan-xyz',
    });

    const landed = events.find((e) => e.id === 'evt-auth-1');
    expect(landed).toBeDefined();
    expect(landed!.service).toBe('auth');
    expect(landed!.actor).toEqual({ kind: 'studio' });
    expect(landed!.authLens).toEqual({ mode: 'admin' });
    expect(landed!.planId).toBe('plan-xyz');
  });

  it('stampProvenance never clobbers fields the event already carries', () => {
    const stamped = stampProvenance(
      {
        kind: 'session_boundary',
        id: 'x',
        at: 0,
        phase: 'reset',
        priorOpCount: 0,
        service: 'storage',
        actor: { kind: 'agent', name: 'pyric' },
      },
      // overrides that should LOSE to the event's pre-set fields
      { service: 'auth', actor: { kind: 'app' } },
    );
    expect(stamped.service).toBe('storage');
    expect(stamped.actor).toEqual({ kind: 'agent', name: 'pyric' });
    // unset field falls through to override, then default
    expect(stamped.authLens).toEqual({ mode: 'app-session' });
  });
});
