import { describe, expect, it } from 'bun:test';
import { GeoPoint, Timestamp, doc } from 'pyric/firestore';
import {
  createEphemeralHandles,
  createLiveRefusedError,
  readOnlyFirestoreApi,
  rehydrateObservedFirestoreDoc,
} from '../../src/shell/observed-session-mirror.js';

describe('createLiveRefusedError', () => {
  it('tags the refusal with PYRIC_LIVE_REFUSED', () => {
    const err = createLiveRefusedError();
    expect(err.code).toBe('PYRIC_LIVE_REFUSED');
    expect(err.message).toContain('read-only');
  });
});

describe('readOnlyFirestoreApi', () => {
  it('refuses every mutation', async () => {
    const handles = createEphemeralHandles();
    const ref = doc(handles.adminFirestore, 'items/a');
    const api = readOnlyFirestoreApi as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const op of ['setDoc', 'addDoc', 'deleteDoc']) {
      await expect(api[op]!(ref, {})).rejects.toMatchObject({ code: 'PYRIC_LIVE_REFUSED' });
    }
  });
});

describe('rehydrateObservedFirestoreDoc', () => {
  it('turns JSON forms back into SDK values and drops prototype keys', () => {
    const handles = createEphemeralHandles();
    const raw = JSON.parse(
      '{"at":{"seconds":10,"nanoseconds":0},"where":{"latitude":1,"longitude":2},"ref":{"type":"document","path":"/items/b","id":"b"},"nested":{"__proto__":{"x":1},"n":1},"plain":{"seconds":1}}',
    );
    const out = rehydrateObservedFirestoreDoc(handles.adminFirestore, raw);
    expect(out.at).toBeInstanceOf(Timestamp);
    expect(out.where).toBeInstanceOf(GeoPoint);
    expect((out.ref as { path: string }).path).toBe('items/b');
    expect(out.nested).toEqual({ n: 1 });
    expect(out.plain).toEqual({ seconds: 1 });
  });

  it('unwraps pyric/map/1.0 envelopes without coercing colliding shapes and restores IEEE-754 special floats', () => {
    const handles = createEphemeralHandles();
    const out = rehydrateObservedFirestoreDoc(handles.adminFirestore, {
      type: 'pyric/map/1.0',
      fields: {
        coordsMap: { type: 'pyric/map/1.0', fields: { latitude: 12.5, longitude: 42.25 } },
        spanMap: { type: 'pyric/map/1.0', fields: { seconds: 30, nanoseconds: 0 } },
        negZero: { type: 'pyric/number/1.0', value: '-0' },
        nanVal: { type: 'pyric/number/1.0', value: 'NaN' },
        posInf: { type: 'pyric/number/1.0', value: 'Infinity' },
        negInf: { type: 'pyric/number/1.0', value: '-Infinity' },
        numMap: { type: 'pyric/map/1.0', fields: { type: 'pyric/number/1.0', value: '-0' } },
      },
    });
    expect(out.coordsMap).not.toBeInstanceOf(GeoPoint);
    expect(out.coordsMap).toEqual({ latitude: 12.5, longitude: 42.25 });
    expect(out.spanMap).not.toBeInstanceOf(Timestamp);
    expect(out.spanMap).toEqual({ seconds: 30, nanoseconds: 0 });
    expect(Object.is(out.negZero, -0)).toBe(true);
    expect(Number.isNaN(out.nanVal)).toBe(true);
    expect(out.posInf).toBe(Number.POSITIVE_INFINITY);
    expect(out.negInf).toBe(Number.NEGATIVE_INFINITY);
    expect(out.numMap).toEqual({ type: 'pyric/number/1.0', value: '-0' });
  });
});
