import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import { selectActivity, toActivityRow } from './activity.js';

const write = (over: Record<string, unknown> = {}): SandboxEvent =>
  ({
    kind: 'write',
    id: over.id ?? 'w1',
    at: 1000,
    method: 'set',
    path: 'users/alice',
    auth: null,
    priorState: null,
    nextState: {},
    ...over,
  }) as unknown as SandboxEvent;

const denial = (over: Record<string, unknown> = {}): SandboxEvent =>
  ({
    kind: 'request',
    id: over.id ?? 'r1',
    at: 2000,
    evalMs: 1,
    method: 'update',
    path: 'users/bob',
    auth: { uid: 'bob' },
    result: 'deny',
    reasons: [],
    origin: 'user',
    ...over,
  }) as unknown as SandboxEvent;

describe('home activity projection', () => {
  it('projects a committed write to its Firestore subject', () => {
    const row = toActivityRow(write());
    expect(row).toMatchObject({
      denied: false,
      summary: 'set /users/alice',
      target: { tab: 'firestore', rest: ['users', 'alice'] },
    });
  });

  it('projects a denial to the Traffic drill-in', () => {
    const row = toActivityRow(denial());
    expect(row).toMatchObject({
      denied: true,
      target: { tab: 'traffic', query: { denial: 'r1' } },
    });
    expect(row?.identity).toBe('bob');
  });

  it('skips allowed reads (Traffic domain)', () => {
    expect(toActivityRow(denial({ result: 'allow', method: 'get' }))).toBeNull();
  });

  it('stamps agent provenance from the event actor', () => {
    const row = toActivityRow(write({ actor: { kind: 'agent', name: 'claude' } }));
    expect(row).toMatchObject({ provenance: 'agent', identity: 'agent:claude' });
  });

  it('projects auth mutations to the Auth user', () => {
    const row = toActivityRow({
      kind: 'service_mutation',
      id: 's1',
      at: 3000,
      service: 'auth',
      op: 'user_create',
      path: 'u-1',
      auth: null,
    } as unknown as SandboxEvent);
    expect(row).toMatchObject({
      summary: 'auth user_create u-1',
      target: { tab: 'auth', rest: ['u-1'] },
    });
  });

  it('projects storage mutations to the object path', () => {
    const row = toActivityRow({
      kind: 'service_mutation',
      id: 's2',
      at: 3000,
      service: 'storage',
      op: 'object_put',
      path: 'uploads/logo.png',
      auth: null,
    } as unknown as SandboxEvent);
    expect(row?.target).toEqual({ tab: 'storage', rest: ['uploads', 'logo.png'] });
  });

  it('caps at N newest, newest first', () => {
    const events = Array.from({ length: 30 }, (_, i) =>
      write({ id: `w${i}`, at: i }),
    );
    const rows = selectActivity(events, 20);
    expect(rows.length).toBe(20);
    expect(rows[0].id).toBe('w29');
    expect(rows[19].id).toBe('w10');
  });
});
