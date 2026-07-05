/**
 * Item 1 — Timestamp + serverTimestamp parity tests.
 *
 * Plan §Item 1 test contract:
 *   - Rule `resource.data.createdAt is timestamp` returns true for:
 *     (a) seed data containing `new Date()`,
 *     (b) writes with `serverTimestamp()` sentinel,
 *     (c) seed data with explicit `Timestamp` wrapper.
 *   - Reading a doc back after a `serverTimestamp()` write returns a
 *     `Timestamp` instance, not a sentinel object.
 *   - Discover-side: schema reports `scalar:timestamp` for a seeded `Date`.
 *
 * Plus the converter unit-tests for direct contract coverage and the
 * `request.time` coherence assertion (R1 follow-up: rules that compare
 * `data.createdAt == request.time` must keep working when both come from
 * the resolver/handler split).
 */
import { describe, test, expect } from 'bun:test';
import {
  dateConverter,
  serverTimestampConverter,
} from 'pyric/sandbox/internal';
import { KEEP } from 'pyric/sandbox/internal';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { LocalState } from 'pyric/sandbox/internal';
import { Timestamp } from 'pyric/rules';
import { encodeValue } from 'pyric/sandbox/internal';
import { wireValueToFieldType } from 'pyric-tools/discover';
import { LocalEnvironmentCrawlerAdapter } from 'pyric-tools/discover';
import { crawl } from 'pyric-tools/discover';

const ALLOW_ALL =
  "rules_version = '2'; service cloud.firestore { " +
  '  match /databases/{database}/documents {' +
  '    match /{document=**} { allow read, write: if true; }' +
  '  }' +
  '}';

const baseCtx = (overrides: Partial<{ path: string; method: 'create' | 'update' | 'set' | 'seed'; prior: Record<string, unknown> | null; serverTime: unknown; fieldPath: string }> = {}) => ({
  path: 'p/x',
  method: 'create' as const,
  prior: null,
  fieldPath: 'f',
  ...overrides,
});

// ─── Converter unit tests ──────────────────────────────────────────────────

describe('dateConverter', () => {
  test('wraps a Date in a millisecond-precise Timestamp', () => {
    const d = new Date('2026-05-04T10:00:00.123Z');
    const out = dateConverter.convert(d, baseCtx());
    expect(out).toBeInstanceOf(Timestamp);
    expect((out as Timestamp).toMillis()).toBe(d.getTime());
  });

  test('declines non-Date values via KEEP', () => {
    expect(dateConverter.convert(42, baseCtx())).toBe(KEEP);
    expect(dateConverter.convert('a', baseCtx())).toBe(KEEP);
    expect(dateConverter.convert({ a: 1 }, baseCtx())).toBe(KEEP);
    expect(dateConverter.convert(null, baseCtx())).toBe(KEEP);
  });

  test('idempotent on its own output (Timestamp instance) — declines, does not double-wrap', () => {
    // Timestamp is NOT a Date, so the converter declines.
    const ts = Timestamp.fromMillis(123_456);
    expect(dateConverter.convert(ts, baseCtx())).toBe(KEEP);
  });
});

describe('serverTimestampConverter', () => {
  test('resolves the sentinel to ctx.serverTime when supplied', () => {
    const pinned = Timestamp.fromMillis(1_700_000_000_000);
    const out = serverTimestampConverter.convert(
      { __type: 'serverTimestamp' },
      baseCtx({ serverTime: pinned }),
    );
    // SAME instance — important for `data.createdAt == request.time`.
    expect(out).toBe(pinned);
  });

  test('falls back to wallclock Timestamp when ctx.serverTime is absent', () => {
    const before = Date.now();
    const out = serverTimestampConverter.convert(
      { __type: 'serverTimestamp' },
      baseCtx(),
    );
    const after = Date.now();
    expect(out).toBeInstanceOf(Timestamp);
    const ms = (out as Timestamp).toMillis();
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });

  test('declines non-sentinel values', () => {
    expect(serverTimestampConverter.convert({ a: 1 }, baseCtx())).toBe(KEEP);
    expect(serverTimestampConverter.convert({ __type: 'other' }, baseCtx())).toBe(KEEP);
    expect(serverTimestampConverter.convert(null, baseCtx())).toBe(KEEP);
    expect(serverTimestampConverter.convert(new Date(), baseCtx())).toBe(KEEP);
  });

  test('idempotent — Timestamp instances are not re-claimed', () => {
    const ts = Timestamp.fromMillis(9999);
    // Timestamp does not have `__type === 'serverTimestamp'`, so converter declines.
    expect(serverTimestampConverter.convert(ts, baseCtx())).toBe(KEEP);
  });
});

// ─── LocalState integration ─────────────────────────────────────────────

describe('LocalState write boundary — Date and Timestamp persist as Timestamp', () => {
  test('seeded Date is wrapped to Timestamp before storage', () => {
    const date = new Date('2026-05-04T10:00:00.000Z');
    const s = new LocalState({ 'users/u1': { createdAt: date } });
    const stored = s.get('users/u1');
    expect(stored?.['createdAt']).toBeInstanceOf(Timestamp);
    expect((stored?.['createdAt'] as Timestamp).toMillis()).toBe(date.getTime());
  });

  test('seeded Timestamp instance round-trips unchanged (idempotency)', () => {
    const ts = Timestamp.fromMillis(1_700_000_000_000);
    const s = new LocalState({ 'users/u1': { createdAt: ts } });
    // Same instance; resolver must not rewrap or rebuild.
    expect(s.get('users/u1')?.['createdAt']).toBe(ts);
  });

  test('serverTimestamp sentinel resolves to a Timestamp at write boundary', () => {
    const s = new LocalState();
    s.create('logs/l1', { at: { __type: 'serverTimestamp' } });
    const stored = s.get('logs/l1')?.['at'];
    expect(stored).toBeInstanceOf(Timestamp);
  });
});

// ─── LocalEnvironment + rules integration ───────────────────────────────

describe('LocalEnvironment — `is timestamp` rule sees resolved Timestamps', () => {
  function envAllowingIfTimestamp() {
    const env = new LocalEnvironment();
    env.seed({
      rules:
        "rules_version = '2'; service cloud.firestore {" +
        '  match /databases/{database}/documents {' +
        '    match /posts/{p} {' +
        // Allow only when the post-write doc has a timestamp `createdAt`.
        '      allow create: if request.resource.data.createdAt is timestamp;' +
        '    }' +
        '  }' +
        '}',
      documents: {},
    });
    return env;
  }

  test('(a) raw `new Date()` in write data passes `is timestamp`', () => {
    const env = envAllowingIfTimestamp();
    const r = env.execute({
      method: 'create', path: 'posts/p1', auth: { uid: 'u1' },
      data: { createdAt: new Date('2026-05-04T10:00:00Z') },
    });
    expect(r.allowed).toBe(true);
  });

  test('(b) `{ __type: "serverTimestamp" }` sentinel passes `is timestamp`', () => {
    const env = envAllowingIfTimestamp();
    const r = env.execute({
      method: 'create', path: 'posts/p1', auth: { uid: 'u1' },
      data: { createdAt: { __type: 'serverTimestamp' } },
    });
    expect(r.allowed).toBe(true);
    // And the stored value is a Timestamp instance, not the sentinel.
    expect(env.getDocument('posts/p1')?.['createdAt']).toBeInstanceOf(Timestamp);
  });

  test('(c) explicit `Timestamp` instance in write data passes `is timestamp`', () => {
    const env = envAllowingIfTimestamp();
    const r = env.execute({
      method: 'create', path: 'posts/p1', auth: { uid: 'u1' },
      data: { createdAt: Timestamp.fromMillis(1_700_000_000_000) },
    });
    expect(r.allowed).toBe(true);
  });

  test('non-timestamp value still denied — confirms rule is actually checking', () => {
    const env = envAllowingIfTimestamp();
    const r = env.execute({
      method: 'create', path: 'posts/p1', auth: { uid: 'u1' },
      data: { createdAt: 'not-a-timestamp' },
    });
    expect(r.allowed).toBe(false);
  });

  test('post-serverTimestamp doc reads back as a Timestamp instance, not a sentinel', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: ALLOW_ALL });
    env.execute({
      method: 'create', path: 'logs/l1', auth: { uid: 'u1' },
      data: { at: { __type: 'serverTimestamp' } },
    });
    const at = env.getDocument('logs/l1')?.['at'];
    expect(at).toBeInstanceOf(Timestamp);
    // The sentinel shape must be gone.
    expect((at as Record<string, unknown>)?.['__type']).toBeUndefined();
  });
});

// ─── request.time coherence ─────────────────────────────────────────────

describe('LocalEnvironment — request.time and resolved sentinel share an instant', () => {
  test('rule `data.createdAt == request.time` succeeds for a serverTimestamp write', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules:
        "rules_version = '2'; service cloud.firestore {" +
        '  match /databases/{database}/documents {' +
        '    match /events/{e} {' +
        // The resolver and handler both pin to the same wallclock — the
        // only way this rule passes is if we plumbed serverTime through.
        '      allow create: if request.resource.data.createdAt == request.time;' +
        '    }' +
        '  }' +
        '}',
      documents: {},
    });
    const r = env.execute({
      method: 'create', path: 'events/e1', auth: { uid: 'u1' },
      data: { createdAt: { __type: 'serverTimestamp' } },
    });
    expect(r.allowed).toBe(true);
  });
});

// ─── wire-encoder + discover round-trip ─────────────────────────────────

describe('wire-encoder — Date and Timestamp emit timestampValue', () => {
  test('Date encodes as `timestampValue: { seconds, nanos }`', () => {
    const d = new Date('2026-05-04T10:00:00.500Z');
    const wire = encodeValue(d) as { timestampValue: { seconds: number; nanos: number } };
    expect(wire.timestampValue).toBeDefined();
    expect(wire.timestampValue.seconds).toBe(Math.floor(d.getTime() / 1000));
    expect(wire.timestampValue.nanos).toBe((d.getTime() % 1000) * 1_000_000);
  });

  test('Timestamp wrapper encodes as `timestampValue` with its own seconds/nanos', () => {
    const ts = new Timestamp(1_700_000_000, 123_000_000);
    const wire = encodeValue(ts) as { timestampValue: { seconds: number; nanos: number } };
    expect(wire.timestampValue).toEqual({ seconds: 1_700_000_000, nanos: 123_000_000 });
  });

  test('round-trip encode → decode → FieldType yields scalar:timestamp', () => {
    const wire = encodeValue(new Date('2026-05-04T10:00:00Z'));
    const ft = wireValueToFieldType(wire);
    expect(ft).toEqual({ kind: 'scalar', type: 'timestamp' });
  });

  test('discover crawl on Date-seeded data reports scalar:timestamp', async () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: ALLOW_ALL,
      documents: {
        'events/e1': { createdAt: new Date('2026-05-04T10:00:00Z'), name: 'first' },
      },
    });
    const adapter = new LocalEnvironmentCrawlerAdapter(env);
    const result = await crawl(adapter);
    const eventsSchema = result.finalizedSchemas.get('events');
    expect(eventsSchema).toBeDefined();
    const createdAtTypes = eventsSchema!.schema.fields['createdAt']?.types;
    expect(createdAtTypes).toBeDefined();
    expect(createdAtTypes!.some((t) => t.kind === 'scalar' && t.type === 'timestamp')).toBe(true);
  });
});
