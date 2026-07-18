/**
 * Wire-encoder tests for Bytes + GeoPoint round-trip (closes
 * `packages/firestore/COMPAT.md` rows #109 + #110).
 *
 * Two layers under test:
 *
 *   1. **Converter unit:** `bytesConverter` / `geoPointConverter`
 *      duck-type-detect `firebase/firestore`'s `Bytes` / `GeoPoint`
 *      shapes and substitute the `pyric/rules` wrappers
 *      (`Bytes`, `LatLng`). KEEP on idempotency, on plain shapes that
 *      lack the duck-type, and on non-objects.
 *
 *   2. **Storage round-trip:** writing a doc with the rules-wrapper
 *      forms through `LocalEnvironment.execute({ method: 'create' })`
 *      and reading it back via `getDocument` returns the same wrapper
 *      instances — so the final `pyric/firestore` translation hop
 *      (rules wrapper → `firebase/firestore.Bytes` / `.GeoPoint`) has
 *      a stable source. The end-to-end fb.Bytes → fb.Bytes round-trip
 *      through setDoc / getDoc is verified at
 *      `packages/firestore/test/sandbox-target.test.ts`.
 *
 * The `firebase/firestore` shape is faked with a minimal duck-typed
 * object — `pyric/sandbox` deliberately doesn't depend on `firebase`,
 * matching the converter's duck-typing approach. The integration test
 * at the `pyric/firestore` layer uses the real `firebase/firestore`
 * exports.
 */
import { describe, test, expect } from 'bun:test';
import {
  bytesConverter,
  geoPointConverter,
} from '../../../src/firestore/sandbox/converters/bytes-geopoint.js';
import { KEEP } from '../../../src/firestore/sandbox/value-resolver.js';
import { LocalEnvironment } from '../../../src/firestore/sandbox/local-environment.js';
import { Bytes as RulesBytes, LatLng } from 'pyric/rules/internal';

const baseCtx = (
  overrides: Partial<{
    path: string;
    method: 'create' | 'update' | 'set' | 'seed';
    prior: Record<string, unknown> | null;
    fieldPath: string;
    serverTime: unknown;
  }> = {},
) => ({
  path: 'p/x',
  method: 'create' as const,
  prior: null,
  fieldPath: 'value',
  ...overrides,
});

/** Build a duck-typed `firebase/firestore`-shaped Bytes for converter tests. */
function fakeFbBytes(bytes: Uint8Array): unknown {
  return {
    toBase64(): string {
      // The fb encoding uses standard base64 (with `+`/`/`/`=`). The
      // converter doesn't read the base64 string — it pulls a Uint8Array
      // via toUint8Array — so a plain stub is fine here.
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
      return btoa(bin);
    },
    toUint8Array(): Uint8Array {
      return bytes.slice();
    },
    isEqual(_other: unknown): boolean {
      return false;
    },
  };
}

/** Build a duck-typed `firebase/firestore`-shaped GeoPoint for converter tests. */
function fakeFbGeoPoint(lat: number, lng: number): unknown {
  return {
    latitude: lat,
    longitude: lng,
    isEqual(_other: unknown): boolean {
      return false;
    },
  };
}

// ─── Converter unit tests ──────────────────────────────────────────────────

describe('bytesConverter', () => {
  test('wraps a firebase/firestore-shaped Bytes into our RulesBytes', () => {
    const out = bytesConverter.convert(
      fakeFbBytes(new Uint8Array([1, 2, 3, 4])),
      baseCtx(),
    );
    expect(out).toBeInstanceOf(RulesBytes);
    expect(Array.from((out as RulesBytes).data)).toEqual([1, 2, 3, 4]);
  });

  test('idempotent: a RulesBytes wrapper on a second pass declines', () => {
    const b = new RulesBytes(new Uint8Array([9, 9, 9]));
    expect(bytesConverter.convert(b, baseCtx())).toBe(KEEP);
  });

  test('declines plain values', () => {
    expect(bytesConverter.convert('abc', baseCtx())).toBe(KEEP);
    expect(bytesConverter.convert(42, baseCtx())).toBe(KEEP);
    expect(bytesConverter.convert(null, baseCtx())).toBe(KEEP);
    expect(bytesConverter.convert({ a: 1 }, baseCtx())).toBe(KEEP);
  });

  test('declines plain objects that lack the duck-typed methods', () => {
    // Has toBase64 but no toUint8Array — partial match must not claim.
    expect(
      bytesConverter.convert({ toBase64: () => '' }, baseCtx()),
    ).toBe(KEEP);
    // Has toBase64 + toUint8Array but isEqual is not a function.
    expect(
      bytesConverter.convert(
        {
          toBase64: () => '',
          toUint8Array: () => new Uint8Array(),
          isEqual: 'nope',
        },
        baseCtx(),
      ),
    ).toBe(KEEP);
  });
});

describe('geoPointConverter', () => {
  test('wraps a firebase/firestore-shaped GeoPoint into our LatLng', () => {
    const out = geoPointConverter.convert(
      fakeFbGeoPoint(37.7749, -122.4194),
      baseCtx(),
    );
    expect(out).toBeInstanceOf(LatLng);
    expect((out as LatLng).lat).toBe(37.7749);
    expect((out as LatLng).lng).toBe(-122.4194);
  });

  test('idempotent: a LatLng wrapper on a second pass declines', () => {
    const g = new LatLng(1, 2);
    expect(geoPointConverter.convert(g, baseCtx())).toBe(KEEP);
  });

  test('declines plain values', () => {
    expect(geoPointConverter.convert('1,2', baseCtx())).toBe(KEEP);
    expect(geoPointConverter.convert(42, baseCtx())).toBe(KEEP);
    expect(geoPointConverter.convert(null, baseCtx())).toBe(KEEP);
    expect(geoPointConverter.convert({ a: 1 }, baseCtx())).toBe(KEEP);
  });

  test('declines plain objects that look like GeoPoint but miss isEqual', () => {
    expect(
      geoPointConverter.convert(
        { latitude: 1, longitude: 2 },
        baseCtx(),
      ),
    ).toBe(KEEP);
  });

  test('declines plain objects whose latitude/longitude are wrong type', () => {
    expect(
      geoPointConverter.convert(
        { latitude: '1', longitude: 2, isEqual: () => false },
        baseCtx(),
      ),
    ).toBe(KEEP);
  });
});

// ─── Storage round-trip ────────────────────────────────────────────────────

const ALLOW_ALL =
  "rules_version = '2'; service cloud.firestore { " +
  '  match /databases/{database}/documents {' +
  '    match /{document=**} { allow read, write: if true; }' +
  '  }' +
  '}';

function newEnv(): LocalEnvironment {
  const env = new LocalEnvironment();
  env.seed({ rules: ALLOW_ALL, documents: {} });
  return env;
}

describe('Bytes round-trip via LocalEnvironment', () => {
  test('a top-level fb.Bytes-shaped value lands as a RulesBytes instance', () => {
    const env = newEnv();
    const data = { payload: fakeFbBytes(new Uint8Array([10, 20, 30])) };
    const res = env.execute({ method: 'create', path: 'docs/d1', data });
    expect(res.allowed).toBe(true);
    const stored = env.getDocument('docs/d1') as Record<string, unknown>;
    expect(stored.payload).toBeInstanceOf(RulesBytes);
    expect(Array.from((stored.payload as RulesBytes).data)).toEqual([
      10, 20, 30,
    ]);
  });

  test('nested fb.Bytes-shaped values inside objects + arrays round-trip', () => {
    const env = newEnv();
    const data = {
      header: { sig: fakeFbBytes(new Uint8Array([1])) },
      chunks: [
        fakeFbBytes(new Uint8Array([1, 2])),
        fakeFbBytes(new Uint8Array([3, 4])),
      ],
    };
    env.execute({ method: 'create', path: 'docs/d2', data });
    const stored = env.getDocument('docs/d2') as {
      header: { sig: RulesBytes };
      chunks: RulesBytes[];
    };
    expect(stored.header.sig).toBeInstanceOf(RulesBytes);
    expect(Array.from(stored.header.sig.data)).toEqual([1]);
    expect(stored.chunks[0]).toBeInstanceOf(RulesBytes);
    expect(Array.from(stored.chunks[0]!.data)).toEqual([1, 2]);
    expect(stored.chunks[1]).toBeInstanceOf(RulesBytes);
    expect(Array.from(stored.chunks[1]!.data)).toEqual([3, 4]);
  });

  test('updateDoc with a fb.Bytes-shaped value round-trips', () => {
    const env = newEnv();
    env.execute({ method: 'create', path: 'docs/d3', data: { v: 0 } });
    env.execute({
      method: 'update',
      path: 'docs/d3',
      data: { payload: fakeFbBytes(new Uint8Array([0xff])) },
    });
    const stored = env.getDocument('docs/d3') as Record<string, unknown>;
    expect(stored.payload).toBeInstanceOf(RulesBytes);
    expect(Array.from((stored.payload as RulesBytes).data)).toEqual([0xff]);
    expect(stored.v).toBe(0);
  });
});

describe('GeoPoint round-trip via LocalEnvironment', () => {
  test('a top-level fb.GeoPoint-shaped value lands as a LatLng instance', () => {
    const env = newEnv();
    const data = { loc: fakeFbGeoPoint(37.7749, -122.4194) };
    const res = env.execute({ method: 'create', path: 'docs/g1', data });
    expect(res.allowed).toBe(true);
    const stored = env.getDocument('docs/g1') as Record<string, unknown>;
    expect(stored.loc).toBeInstanceOf(LatLng);
    expect((stored.loc as LatLng).lat).toBe(37.7749);
    expect((stored.loc as LatLng).lng).toBe(-122.4194);
  });

  test('nested fb.GeoPoint-shaped values inside objects + arrays round-trip', () => {
    const env = newEnv();
    const data = {
      home: { coord: fakeFbGeoPoint(1.5, 2.5) },
      trail: [fakeFbGeoPoint(0, 0), fakeFbGeoPoint(10, -10)],
    };
    env.execute({ method: 'create', path: 'docs/g2', data });
    const stored = env.getDocument('docs/g2') as {
      home: { coord: LatLng };
      trail: LatLng[];
    };
    expect(stored.home.coord).toBeInstanceOf(LatLng);
    expect(stored.home.coord.lat).toBe(1.5);
    expect(stored.home.coord.lng).toBe(2.5);
    expect(stored.trail[0]).toBeInstanceOf(LatLng);
    expect(stored.trail[0]!.lat).toBe(0);
    expect(stored.trail[1]).toBeInstanceOf(LatLng);
    expect(stored.trail[1]!.lat).toBe(10);
    expect(stored.trail[1]!.lng).toBe(-10);
  });

  test('updateDoc with a fb.GeoPoint-shaped value round-trips', () => {
    const env = newEnv();
    env.execute({ method: 'create', path: 'docs/g3', data: { label: 'home' } });
    env.execute({
      method: 'update',
      path: 'docs/g3',
      data: { loc: fakeFbGeoPoint(45, 90) },
    });
    const stored = env.getDocument('docs/g3') as Record<string, unknown>;
    expect(stored.loc).toBeInstanceOf(LatLng);
    expect((stored.loc as LatLng).lat).toBe(45);
    expect((stored.loc as LatLng).lng).toBe(90);
    expect(stored.label).toBe('home');
  });
});
