import { describe, expect, it } from 'bun:test';
import {
  readObservedSessionDelta,
  SessionDeltaRejected,
  skipReasonOf,
} from '../../../src/serve/observed-session/delta-validation.js';

function rejectionOf(raw: unknown): SessionDeltaRejected {
  try {
    readObservedSessionDelta(raw);
  } catch (error) {
    if (error instanceof SessionDeltaRejected) return error;
    throw error;
  }
  throw new Error('expected the delta to be rejected');
}

describe('readObservedSessionDelta', () => {
  it('accepts valid Firestore and RTDB session deltas including partial flags and RTDB invalidations', () => {
    const delta = readObservedSessionDelta({
      firestore: [
        { kind: 'set', path: 'users/ada', data: { name: 'Ada' }, merge: true, deleteFields: ['old'], partial: true },
        { kind: 'update', path: 'users/ada', data: { 'profile.role': 'admin' }, partial: false },
        { kind: 'delete', path: 'users/gone' },
      ],
      rtdb: [
        { kind: 'set', instance: 'demo-default-rtdb', path: '/rooms/r1', value: { open: true } },
        { kind: 'update', instance: 'demo-default-rtdb', path: '/rooms', value: { 'r2/open': false } },
        { kind: 'remove', instance: 'demo-default-rtdb', path: '/rooms/r3' },
        { kind: 'invalidate', instance: 'demo-default-rtdb', path: '/rooms/r1/closedAt' },
      ],
    });
    expect(delta.firestore).toEqual([
      { kind: 'set', path: 'users/ada', data: { name: 'Ada' }, merge: true, deleteFields: ['old'], partial: true },
      { kind: 'update', path: 'users/ada', data: { 'profile.role': 'admin' } },
      { kind: 'delete', path: 'users/gone' },
    ]);
    expect(delta.rtdb).toHaveLength(4);
    expect(rejectionOf({ firestore: [{ kind: 'update', path: 'users/ada', data: {}, partial: 'yes' }] }).reason).toBe(
      'unsupported',
    );
    expect(rejectionOf({ rtdb: [{ kind: 'invalidate', instance: 'demo', path: '/bad.key/a' }] }).reason).toBe(
      'unsupported',
    );
  });

  it('leaves out empty op lists, an empty deleteFields, and zero skip counts', () => {
    const delta = readObservedSessionDelta({
      firestore: [{ kind: 'set', path: 'items/1', data: { n: 1 }, deleteFields: [] }],
      rtdb: [],
      skipped: { oversized: 0, truncated: 2 },
    });
    expect(delta).toEqual({
      firestore: [{ kind: 'set', path: 'items/1', data: { n: 1 } }],
      skipped: { truncated: 2 },
    });
  });

  it('rejects prototype-pollution keys, invalid Firestore/RTDB paths, and non-finite numbers as unsupported', () => {
    const poisoned = JSON.parse('{"firestore":[{"kind":"set","path":"users/a","data":{"__proto__":{"polluted":true}}}]}');
    expect(() => readObservedSessionDelta(poisoned)).toThrow(/forbidden.*key/);
    expect(rejectionOf(poisoned).reason).toBe('unsupported');

    const notADocument = { firestore: [{ kind: 'set', path: 'users', data: { a: 1 } }] };
    expect(() => readObservedSessionDelta(notADocument)).toThrow(/valid Firestore document path/);
    expect(rejectionOf(notADocument).reason).toBe('unsupported');

    const badSegment = { rtdb: [{ kind: 'set', instance: 'demo', path: '/bad.key/child', value: 1 }] };
    expect(() => readObservedSessionDelta(badSegment)).toThrow(/forbidden characters/);

    const notFinite = { firestore: [{ kind: 'set', path: 'users/a', data: { bad: Number.NaN } }] };
    expect(() => readObservedSessionDelta(notFinite)).toThrow(/non-finite/);
  });

  it('names a too-deep value unsupported, not oversized', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 25; level++) deep = { child: deep };
    const rejection = rejectionOf({ rtdb: [{ kind: 'set', instance: 'demo', path: '/items/1', value: deep }] });
    expect(rejection.reason).toBe('unsupported');
    expect(rejection.message).toContain('nested deeper');
  });

  it('names a delta over the byte cap oversized, counting UTF-8 bytes', () => {
    // 350K three-byte characters: under 1 MiB in UTF-16 code units, over it in UTF-8 bytes.
    const wide = '\u4e00'.repeat(350_000);
    expect(wide.length).toBeLessThan(1024 * 1024);
    const rejection = rejectionOf({ firestore: [{ kind: 'set', path: 'items/1', data: { text: wide } }] });
    expect(rejection.reason).toBe('oversized');
  });

  it('names a delta with too many operations oversized', () => {
    const ops = Array.from({ length: 501 }, (_, idx) => ({ kind: 'delete', path: `items/${idx}` }));
    expect(rejectionOf({ firestore: ops }).reason).toBe('oversized');
  });

  it('delegates storage ops and counts them toward the per-delta operation cap', () => {
    const delta = readObservedSessionDelta({
      storage: [
        {
          kind: 'upsert',
          bucket: 'demo-proj.firebasestorage.app',
          fullPath: 'items/item-1.png',
          metadata: { size: 64, contentType: 'image/png', customMetadata: { apiKey: 'secret' } },
        },
      ],
    });
    expect(delta.storage).toEqual([
      {
        kind: 'upsert',
        bucket: 'demo-proj.firebasestorage.app',
        fullPath: 'items/item-1.png',
        metadata: { size: 64, contentType: 'image/png', customMetadata: { apiKey: '[REDACTED]' } },
      },
    ]);
  });

  it('accepts pyric/map/1.0 envelopes, preserves string fields verbatim, and rejects nested forbidden RTDB keys', () => {
    const delta = readObservedSessionDelta({
      firestore: [
        {
          kind: 'set',
          path: 'users/ada',
          data: {
            email: 'ada@example.test',
            tokenField: 'raw-user-string',
            coordsMap: { type: 'pyric/map/1.0', fields: { latitude: 12.5, longitude: 42.25 } },
          },
        },
      ],
      rtdb: [
        {
          kind: 'set',
          instance: 'demo-default-rtdb',
          path: '/accounts/ada',
          value: {
            email: 'ada@example.test',
            label: 'active',
          },
        },
      ],
    });
    expect(delta.firestore).toEqual([
      {
        kind: 'set',
        path: 'users/ada',
        data: {
          email: 'ada@example.test',
          tokenField: 'raw-user-string',
          coordsMap: { type: 'pyric/map/1.0', fields: { latitude: 12.5, longitude: 42.25 } },
        },
      },
    ]);
    expect(delta.rtdb).toEqual([
      {
        kind: 'set',
        instance: 'demo-default-rtdb',
        path: '/accounts/ada',
        value: {
          email: 'ada@example.test',
          label: 'active',
        },
      },
    ]);

    for (const badKey of ['nested.bad', 'a$b', 'a#b', 'a[0]', 'a/b', 'bad\u0000key']) {
      const nestedSet = {
        rtdb: [{ kind: 'set', instance: 'demo', path: '/items/i1', value: { [badKey]: 1 } }],
      };
      expect(rejectionOf(nestedSet).reason).toBe('unsupported');
    }
  });
});

describe('skipReasonOf', () => {
  it('reads a rejection\'s own reason and names anything else unsupported', () => {
    expect(skipReasonOf(new SessionDeltaRejected('oversized', 'too big'))).toBe('oversized');
    expect(skipReasonOf(new Error('payload exceeds everything'))).toBe('unsupported');
    expect(skipReasonOf('not an error')).toBe('unsupported');
  });
});
