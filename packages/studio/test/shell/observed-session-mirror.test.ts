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
});
