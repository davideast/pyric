/**
 * Item 4.1 — SessionStore unit tests.
 *
 * Per the implementation plan:
 *   - TTL eviction
 *   - capacity (LRU) eviction
 *   - malformed-token rejection
 *   - ULID uniqueness sweep
 *
 * Plus the structured-error contract from acceptance criteria:
 *   - never throws on expected paths
 *   - SESSION_EXPIRED on unknown/expired
 *   - SESSION_EVICTED for capacity-bumped tokens (with bounded log)
 *   - SESSION_PAYLOAD_TOO_LARGE on per-session byte cap
 *   - default cap values match Phase 3.3 + 0.G locks
 */

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MAX_SESSION_BYTES,
  DEFAULT_TTL_MS,
  SessionStore,
  decodeToken,
  encodeToken,
} from '../../src/discover/session.js';

// ─── Locked defaults ──────────────────────────────────────────────────────

describe('Phase 3.3 + 0.G locks — default cap values', () => {
  test('maxSessions default = 8', () => {
    expect(DEFAULT_MAX_SESSIONS).toBe(8);
  });
  test('maxSessionBytes default = 32 MB', () => {
    expect(DEFAULT_MAX_SESSION_BYTES).toBe(32 * 1024 * 1024);
  });
  test('ttlMs default = 30 minutes', () => {
    expect(DEFAULT_TTL_MS).toBe(30 * 60 * 1000);
  });
});

// ─── Token codec ──────────────────────────────────────────────────────────

describe('token codec — disc_<base64url-ulid>', () => {
  test('round-trips a 16-byte ULID', () => {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = i;
    const token = encodeToken(bytes);
    expect(token.startsWith('disc_')).toBe(true);
    const decoded = decodeToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe(
      '000102030405060708090a0b0c0d0e0f',
    );
  });

  test('rejects token without disc_ prefix', () => {
    expect(decodeToken('AAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
    expect(decodeToken('disk_AAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
  });

  test('rejects empty body, wrong length, illegal characters', () => {
    expect(decodeToken('disc_')).toBeNull();
    expect(decodeToken('disc_AA')).toBeNull(); // too short
    expect(decodeToken('disc_!@#$%^&*()')).toBeNull();
  });

  test('encodeToken throws on wrong-length input (programmer error)', () => {
    expect(() => encodeToken(new Uint8Array(15))).toThrow();
    expect(() => encodeToken(new Uint8Array(17))).toThrow();
  });
});

// ─── create / get / update / delete basics ────────────────────────────────

describe('SessionStore — basic lifecycle', () => {
  test('create returns ok=true with disc_-prefixed token', () => {
    const store = new SessionStore<string>();
    const r = store.create('hello', 5);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.token.startsWith('disc_')).toBe(true);
      expect(r.value.bytes).toBe(5);
      expect(r.value.state).toBe('hello');
    }
  });

  test('get round-trips state', () => {
    const store = new SessionStore<{ x: number }>();
    const created = store.create({ x: 42 }, 10);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const got = store.get(created.value.token);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.state).toEqual({ x: 42 });
  });

  test('update replaces state and bytes', () => {
    const store = new SessionStore<string>();
    const c = store.create('a', 1);
    if (!c.ok) throw new Error('setup');
    const u = store.update(c.value.token, 'bcdef', 5);
    expect(u.ok).toBe(true);
    if (u.ok) {
      expect(u.value.state).toBe('bcdef');
      expect(u.value.bytes).toBe(5);
    }
    const got = store.get(c.value.token);
    if (got.ok) expect(got.value.state).toBe('bcdef');
  });

  test('delete returns true once, false thereafter', () => {
    const store = new SessionStore<string>();
    const c = store.create('a', 1);
    if (!c.ok) throw new Error('setup');
    expect(store.delete(c.value.token)).toBe(true);
    expect(store.delete(c.value.token)).toBe(false);
  });

  test('size reflects live sessions', () => {
    const store = new SessionStore<string>({ maxSessions: 8 });
    expect(store.size).toBe(0);
    store.create('a', 1);
    store.create('b', 1);
    expect(store.size).toBe(2);
  });
});

// ─── Error contract — structured, never throws ────────────────────────────

describe('SessionStore — structured errors', () => {
  test('get on malformed token returns SESSION_MALFORMED_TOKEN', () => {
    const store = new SessionStore<string>();
    const r = store.get('not-a-token');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('SESSION_MALFORMED_TOKEN');
      expect(r.error.recoveryHint.length).toBeGreaterThan(0);
    }
  });

  test('get on unknown-but-well-formed token returns SESSION_EXPIRED', () => {
    const store = new SessionStore<string>();
    const fakeToken = encodeToken(new Uint8Array(16)); // never created
    const r = store.get(fakeToken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SESSION_EXPIRED');
  });

  test('create with payload exceeding cap → SESSION_PAYLOAD_TOO_LARGE', () => {
    const store = new SessionStore<string>({ maxSessionBytes: 100 });
    const r = store.create('x', 101);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SESSION_PAYLOAD_TOO_LARGE');
  });

  test('update beyond byte cap → SESSION_PAYLOAD_TOO_LARGE', () => {
    const store = new SessionStore<string>({ maxSessionBytes: 100 });
    const c = store.create('x', 50);
    if (!c.ok) throw new Error('setup');
    const u = store.update(c.value.token, 'huge', 200);
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.error.code).toBe('SESSION_PAYLOAD_TOO_LARGE');
  });

  test('all error responses carry a non-empty recoveryHint', () => {
    const store = new SessionStore<string>({ maxSessionBytes: 1 });
    const cases = [
      store.get('garbage'),
      store.get(encodeToken(new Uint8Array(16))),
      store.create('xy', 100),
    ];
    for (const r of cases) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.recoveryHint.length).toBeGreaterThan(0);
    }
  });
});

// ─── TTL eviction (per 0.C) ───────────────────────────────────────────────

describe('SessionStore — TTL eviction', () => {
  test('session expires after TTL elapses; get returns SESSION_EXPIRED', () => {
    let now = 1000;
    const store = new SessionStore<string>({
      ttlMs: 100,
      now: () => now,
    });
    const c = store.create('x', 1);
    if (!c.ok) throw new Error('setup');
    now += 50; // half TTL — still alive
    expect(store.get(c.value.token).ok).toBe(true);
    now += 200; // way past TTL since last access
    const r = store.get(c.value.token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SESSION_EXPIRED');
  });

  test('get touches lastAccessedAt — session stays alive when polled', () => {
    let now = 1000;
    const store = new SessionStore<string>({
      ttlMs: 100,
      now: () => now,
    });
    const c = store.create('x', 1);
    if (!c.ok) throw new Error('setup');
    for (let i = 0; i < 5; i++) {
      now += 50;
      const r = store.get(c.value.token);
      expect(r.ok).toBe(true);
    }
    // 250 ms elapsed total, but we polled every 50 ms < TTL=100
    expect(store.size).toBe(1);
  });

  test('sweepExpired returns count of evicted sessions', () => {
    let now = 1000;
    const store = new SessionStore<string>({
      ttlMs: 100,
      now: () => now,
    });
    store.create('a', 1);
    store.create('b', 1);
    store.create('c', 1);
    expect(store.size).toBe(3);
    now += 200;
    expect(store.sweepExpired()).toBe(3);
    expect(store.size).toBe(0);
  });
});

// ─── LRU capacity eviction (per 0.G) ──────────────────────────────────────

describe('SessionStore — LRU capacity eviction', () => {
  test('exceeding maxSessions evicts the LRU; bumped token reports SESSION_EVICTED', () => {
    let now = 1000;
    const store = new SessionStore<string>({
      maxSessions: 3,
      now: () => now,
    });
    const a = store.create('a', 1);
    now += 1;
    const b = store.create('b', 1);
    now += 1;
    const c = store.create('c', 1);
    if (!a.ok || !b.ok || !c.ok) throw new Error('setup');
    // Touch b so its lastAccessedAt is the most recent.
    now += 1;
    store.get(b.value.token);
    now += 1;
    // Adding a 4th should evict 'a' (oldest by lastAccessedAt) since b
    // was just touched and c was the last create.
    const d = store.create('d', 1);
    expect(d.ok).toBe(true);
    expect(store.size).toBe(3);

    const aGet = store.get(a.value.token);
    expect(aGet.ok).toBe(false);
    if (!aGet.ok) expect(aGet.error.code).toBe('SESSION_EVICTED');

    // b and c still alive
    expect(store.get(b.value.token).ok).toBe(true);
    expect(store.get(c.value.token).ok).toBe(true);
  });

  test('TTL-expired sessions swept before LRU eviction fires', () => {
    let now = 1000;
    const store = new SessionStore<string>({
      maxSessions: 2,
      ttlMs: 100,
      now: () => now,
    });
    const a = store.create('a', 1);
    if (!a.ok) throw new Error('setup');
    now += 200; // 'a' is now TTL-expired
    // Create two more — 'a' should be swept by TTL, not evicted by LRU.
    const b = store.create('b', 1);
    const c = store.create('c', 1);
    expect(b.ok && c.ok).toBe(true);

    const aGet = store.get(a.value.token);
    expect(aGet.ok).toBe(false);
    // SESSION_EXPIRED, not SESSION_EVICTED — TTL got it first.
    if (!aGet.ok) expect(aGet.error.code).toBe('SESSION_EXPIRED');
  });

  test('eviction log is bounded — old evictions degrade to SESSION_EXPIRED', () => {
    let now = 1000;
    const store = new SessionStore<string>({
      maxSessions: 1,
      evictionLogSize: 2,
      now: () => now,
    });
    // Create + immediately evict the same slot 5 times. The eviction log
    // can only hold 2 of the displaced tokens.
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      now += 1;
      const r = store.create(`s${i}`, 1);
      if (!r.ok) throw new Error('setup');
      tokens.push(r.value.token);
    }
    // The most-recently-evicted should still report SESSION_EVICTED.
    const recentlyEvicted = store.get(tokens[3]!);
    expect(recentlyEvicted.ok).toBe(false);
    if (!recentlyEvicted.ok) expect(recentlyEvicted.error.code).toBe('SESSION_EVICTED');
    // The oldest evicted has aged out of the log → SESSION_EXPIRED.
    const oldEvicted = store.get(tokens[0]!);
    expect(oldEvicted.ok).toBe(false);
    if (!oldEvicted.ok) expect(oldEvicted.error.code).toBe('SESSION_EXPIRED');
  });
});

// ─── ULID uniqueness ──────────────────────────────────────────────────────

describe('SessionStore — ULID uniqueness sweep', () => {
  test('1000 sessions generate 1000 unique tokens', () => {
    const store = new SessionStore<number>({ maxSessions: 1000 });
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const r = store.create(i, 1);
      expect(r.ok).toBe(true);
      if (r.ok) tokens.add(r.value.token);
    }
    expect(tokens.size).toBe(1000);
  });

  test('tokens issued in the same ms still differ (random tail)', () => {
    let now = 5000;
    const store = new SessionStore<number>({
      maxSessions: 1000,
      now: () => now, // pinned millisecond
    });
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const r = store.create(i, 1);
      if (r.ok) tokens.add(r.value.token);
    }
    expect(tokens.size).toBe(100);
  });

  test('ULID timestamp prefix is monotonic across millisecond boundaries', () => {
    let now = 1_700_000_000_000;
    const tokens: string[] = [];
    // Deterministic randomness so ordering depends only on the timestamp.
    const fixedRand = () => new Uint8Array(10);
    const store = new SessionStore<number>({
      maxSessions: 100,
      now: () => now,
      randomBytes: fixedRand,
    });
    for (let i = 0; i < 10; i++) {
      now += 1;
      const r = store.create(i, 1);
      if (r.ok) tokens.push(r.value.token);
    }
    const sorted = [...tokens].sort();
    expect(sorted).toEqual(tokens);
  });
});

// ─── Constructor validation ───────────────────────────────────────────────

describe('SessionStore — constructor validation', () => {
  test('rejects non-positive maxSessions', () => {
    expect(() => new SessionStore<string>({ maxSessions: 0 })).toThrow(RangeError);
    expect(() => new SessionStore<string>({ maxSessions: -1 })).toThrow(RangeError);
  });
  test('rejects non-positive maxSessionBytes', () => {
    expect(() => new SessionStore<string>({ maxSessionBytes: 0 })).toThrow(RangeError);
  });
  test('rejects non-positive ttlMs', () => {
    expect(() => new SessionStore<string>({ ttlMs: 0 })).toThrow(RangeError);
  });
});
