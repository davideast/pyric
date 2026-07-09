/** Traffic verdict derivation (specs/traffic.md MVP) — pure mapping tests. */
import { describe, expect, it } from 'bun:test';
import {
  actingIdentity,
  denialReasons,
  filterByVerdict,
  subjectTarget,
  verdictFor,
} from './verdict.js';

describe('verdictFor', () => {
  it('maps rule-evaluated results', () => {
    expect(verdictFor({ result: 'allow', origin: 'user' })).toBe('allow');
    expect(verdictFor({ result: 'deny', origin: 'user' })).toBe('deny');
  });

  it('marks rules-bypassed ops as admin (lens or origin), beating allow', () => {
    expect(
      verdictFor({ result: 'allow', origin: 'user', authLens: { mode: 'admin' } }),
    ).toBe('admin');
    expect(verdictFor({ result: 'allow', origin: 'admin' })).toBe('admin');
  });

  it('is blank for non-rule ops', () => {
    expect(verdictFor({ result: 'not-applicable', origin: 'user' })).toBeNull();
    expect(verdictFor({ result: 'unsupported', origin: 'user' })).toBeNull();
    expect(verdictFor({ result: 'error', origin: 'user' })).toBeNull();
  });

  it('does not treat an impersonation lens as admin', () => {
    expect(
      verdictFor({ result: 'deny', origin: 'user', authLens: { mode: 'as', uid: 'alice' } }),
    ).toBe('deny');
  });
});

describe('filterByVerdict', () => {
  const events = [
    { id: 'a', result: 'allow', origin: 'user' },
    { id: 'b', result: 'deny', origin: 'user' },
    { id: 'c', result: 'allow', origin: 'admin' },
    { id: 'd', result: 'not-applicable', origin: 'system' },
  ] as const;

  it('passes everything through on all (including blank-verdict ops)', () => {
    expect(filterByVerdict(events, 'all').map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('filters to one verdict', () => {
    expect(filterByVerdict(events, 'allow').map((e) => e.id)).toEqual(['a']);
    expect(filterByVerdict(events, 'deny').map((e) => e.id)).toEqual(['b']);
    expect(filterByVerdict(events, 'admin').map((e) => e.id)).toEqual(['c']);
  });
});

describe('actingIdentity', () => {
  it('prefers the pinned lens', () => {
    expect(actingIdentity({ auth: { uid: 'tab-user' }, authLens: { mode: 'admin' } })).toBe(
      'admin (rules bypassed)',
    );
    expect(
      actingIdentity({ auth: null, authLens: { mode: 'as', uid: 'alice' } }),
    ).toBe('as alice');
    expect(actingIdentity({ auth: { uid: 'tab-user' }, authLens: { mode: 'anon' } })).toBe(
      'anonymous',
    );
  });

  it('falls back to the op auth state (app-session / absent lens)', () => {
    expect(
      actingIdentity({ auth: { uid: 'bob' }, authLens: { mode: 'app-session' } }),
    ).toBe('bob');
    expect(actingIdentity({ auth: { uid: 'bob' } })).toBe('bob');
    expect(actingIdentity({ auth: null })).toBe('anonymous');
  });
});

describe('subjectTarget', () => {
  it('routes a Firestore op (default service) to its path', () => {
    expect(subjectTarget({ path: 'users/alice' })).toEqual({
      tab: 'firestore',
      rest: ['users', 'alice'],
    });
    expect(subjectTarget({ service: 'firestore', path: 'notes' })).toEqual({
      tab: 'firestore',
      rest: ['notes'],
    });
  });

  it('routes an RTDB op to the viewer tab (path is component state — N4 gap)', () => {
    expect(subjectTarget({ service: 'rtdb', path: '/rooms/r1' })).toEqual({ tab: 'rtdb' });
  });

  it('routes storage to the object path and auth to the uid', () => {
    expect(subjectTarget({ service: 'storage', path: 'uploads/logo.png' })).toEqual({
      tab: 'storage',
      rest: ['uploads', 'logo.png'],
    });
    expect(subjectTarget({ service: 'auth', path: 'u-1' })).toEqual({
      tab: 'auth',
      rest: ['u-1'],
    });
  });

  it('yields nothing for non-addressable subjects', () => {
    expect(subjectTarget({ service: 'auth', path: '*' })).toBeNull();
    expect(subjectTarget({ service: 'rtdb', path: '(service)' })).toBeNull();
    expect(subjectTarget({ path: '' })).toBeNull();
    expect(subjectTarget({ service: 'firestore', path: '/' })).toBeNull();
  });
});

describe('denialReasons', () => {
  it('returns the non-empty reasoning lines', () => {
    expect(denialReasons({ reasons: ['Rule #2 (update) → DENY', '', '  '] })).toEqual([
      'Rule #2 (update) → DENY',
    ]);
    expect(denialReasons({})).toEqual([]);
  });
});
