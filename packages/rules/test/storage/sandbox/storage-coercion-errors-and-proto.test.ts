import { describe, expect, test } from 'bun:test';
import {
  bytes,
  latlng,
  reference,
  storageRules,
  timestamp,
} from '../../../src/index.js';
import { parseStorageRules, type FirestoreLookup } from '../../../src/storage/rules.js';
import { evaluateStorageRules } from '../../../src/storage/rules-evaluator.js';

const BUCKET = 'demo-bucket.appspot.com';

function evalDirectStorage(
  condition: string,
  opts: {
    globalFns?: string;
    serviceFns?: string;
    matchPath?: string;
    matchFns?: string;
    path?: string;
    docs?: Record<string, Record<string, unknown>>;
  } = {},
) {
  const source = `rules_version = '2';
${opts.globalFns ?? ''}
service firebase.storage {
  ${opts.serviceFns ?? ''}
  match /b/{bucket}/o {
    match ${opts.matchPath ?? '/items/{id}'} {
      ${opts.matchFns ?? ''}
      allow get: if ${condition};
    }
  }
}
`;
  const ruleset = storageRules(source, { bucket: BUCKET });
  const oneCase = {
    description: condition,
    expectation: 'ALLOW' as const,
    method: 'get' as const,
    path: opts.path ?? 'items/item-1',
    resource: { size: 4 },
  };
  if (opts.docs !== undefined) {
    return ruleset.explain({ ...oneCase, firestore: opts.docs });
  }
  return ruleset.explain(oneCase);
}

function evalLowLevelStorage(
  condition: string,
  docs?: Record<string, Record<string, unknown>>,
) {
  const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow get: if ${condition};
    }
  }
}
`);
  let lookup: FirestoreLookup | undefined;
  if (docs !== undefined) {
    lookup = {
      get(path: string) {
        if (!Object.hasOwn(docs, path)) return null;
        return docs[path] ?? null;
      },
      exists(path: string) {
        return Object.hasOwn(docs, path);
      },
    };
  }
  return evaluateStorageRules(
    rules,
    {
      request: {
        auth: { uid: 'u1' },
        method: 'get',
        path: `b/${BUCKET}/o/items/item-1`,
      },
      resource: { size: 4 },
    },
    new Date('2026-01-01T00:00:00Z'),
    lookup,
  );
}

describe('Storage firestore.get() plain user maps vs real typed values', () => {
  test('keeps plain user maps as map in storageRules() while preserving explicit value helpers', () => {
    const docs = {
      'items/item-1': {
        plainLoc: { latitude: 37.7, longitude: -122.4 },
        plainUnderscoreLoc: { _latitude: 37.7, _longitude: -122.4 },
        plainMeta: { id: 'item-1', path: 'items/item-1' },
        plainTs: { __type: 'timestamp', seconds: 100, nanos: 0 },
        plainPath: { __type: 'path', path: '/databases/(default)/documents/items/item-1' },
        plainRef: { __type: 'reference', path: 'items/item-1' },
        plainGeoJson: { type: 'firestore/geoPoint/1.0', latitude: 1, longitude: 2 },
        realLatLng: latlng(37.7, -122.4),
        realRef: reference('items/item-1'),
        realTs: timestamp(1700000000000),
        realDate: new Date(1700000000000),
        realBytes: bytes('abc'),
      },
    };

    const res = evalDirectStorage(
      [
        'firestore.get(/databases/(default)/documents/items/$(id)).data.plainLoc is map',
        '!(firestore.get(/databases/(default)/documents/items/$(id)).data.plainLoc is latlng)',
        'firestore.get(/databases/(default)/documents/items/$(id)).data.plainUnderscoreLoc is map',
        '!(firestore.get(/databases/(default)/documents/items/$(id)).data.plainUnderscoreLoc is latlng)',
        'firestore.get(/databases/(default)/documents/items/$(id)).data.plainMeta is map',
        '!(firestore.get(/databases/(default)/documents/items/$(id)).data.plainMeta is path)',
        'firestore.get(/databases/(default)/documents/items/$(id)).data.plainTs is map',
        '!(firestore.get(/databases/(default)/documents/items/$(id)).data.plainTs is timestamp)',
        'firestore.get(/databases/(default)/documents/items/$(id)).data.plainPath is map',
        'firestore.get(/databases/(default)/documents/items/$(id)).data.plainRef is map',
        'firestore.get(/databases/(default)/documents/items/$(id)).data.plainGeoJson is map',
        'firestore.get(/databases/(default)/documents/items/$(id)).data.realLatLng is latlng',
        'firestore.get(/databases/(default)/documents/items/$(id)).data.realRef is path',
        'firestore.get(/databases/(default)/documents/items/$(id)).data.realTs is timestamp',
        'firestore.get(/databases/(default)/documents/items/$(id)).data.realDate is timestamp',
        'firestore.get(/databases/(default)/documents/items/$(id)).data.realBytes is bytes',
      ].join(' && '),
      { docs },
    );

    expect(res.decision).toBe('ALLOW');
  });

  test('does not coerce plain {latitude, longitude} or WeakSet-registered unescaped maps in low-level evaluateStorageRules() while converting SDK GeoPoint instances', () => {
    class FakeSdkGeoPoint {
      constructor(
        readonly latitude: number,
        readonly longitude: number,
      ) {}
      isEqual(other: unknown): boolean {
        return other instanceof FakeSdkGeoPoint
          && other.latitude === this.latitude
          && other.longitude === this.longitude;
      }
    }

    const registryKey = Symbol.for('pyric.firestore.unescaped-user-maps');
    const store = globalThis as Record<symbol, WeakSet<object> | undefined>;
    let registry = store[registryKey];
    if (registry === undefined) {
      registry = new WeakSet<object>();
      store[registryKey] = registry;
    }

    const registeredMeta = { id: 'item-1', path: 'items/item-1' };
    const registeredTs = { __type: 'timestamp', seconds: 100, nanos: 0 };
    registry.add(registeredMeta);
    registry.add(registeredTs);

    const res = evalLowLevelStorage(
      [
        'firestore.get(/databases/(default)/documents/items/$(id)).data.plainLoc is map',
        '!(firestore.get(/databases/(default)/documents/items/$(id)).data.plainLoc is latlng)',
        'firestore.get(/databases/(default)/documents/items/$(id)).data.sdkGeo is latlng',
        'firestore.get(/databases/(default)/documents/items/$(id)).data.meta is map',
        '!(firestore.get(/databases/(default)/documents/items/$(id)).data.meta is path)',
        'firestore.get(/databases/(default)/documents/items/$(id)).data.ts is map',
        '!(firestore.get(/databases/(default)/documents/items/$(id)).data.ts is timestamp)',
      ].join(' && '),
      {
        'items/item-1': {
          plainLoc: { latitude: 37.7, longitude: -122.4 },
          sdkGeo: new FakeSdkGeoPoint(37.7, -122.4),
          meta: registeredMeta,
          ts: registeredTs,
        },
      },
    );

    expect(res.allowed).toBe(true);
  });
});

describe('Storage unknown namespace methods return absorbable evaluation errors', () => {
  test('hashing.<unknown>() denies alone and is absorbed by || true and && false', () => {
    const alone = evalDirectStorage("hashing.sha512('abc') == b'x'");
    expect(alone.decision).toBe('DENY');

    const orTrue = evalDirectStorage("hashing.sha512('abc') || true");
    expect(orTrue.decision).toBe('ALLOW');

    const trueOr = evalDirectStorage("true || hashing.sha512('abc')");
    expect(trueOr.decision).toBe('ALLOW');

    const andFalse = evalDirectStorage("!(hashing.sha512('abc') && false)");
    expect(andFalse.decision).toBe('ALLOW');

    const falseAnd = evalDirectStorage("!(false && hashing.sha512('abc'))");
    expect(falseAnd.decision).toBe('ALLOW');
  });

  test('firestore.<unknown>() denies alone and is absorbed by || true and && false', () => {
    const docs = { 'items/item-1': { ok: true } };

    const alone = evalDirectStorage(
      'firestore.unknown(/databases/(default)/documents/items/item-1) == true',
      { docs },
    );
    expect(alone.decision).toBe('DENY');

    const orTrue = evalDirectStorage(
      'firestore.unknown(/databases/(default)/documents/items/item-1) || true',
      { docs },
    );
    expect(orTrue.decision).toBe('ALLOW');

    const andFalse = evalDirectStorage(
      '!(firestore.unknown(/databases/(default)/documents/items/item-1) && false)',
      { docs },
    );
    expect(andFalse.decision).toBe('ALLOW');

    const scalarArgOrTrue = evalDirectStorage("firestore.unknown('x') || true", { docs });
    expect(scalarArgOrTrue.decision).toBe('ALLOW');
  });
});

describe('Storage evaluator supports __proto__ in scopes and path bindings', () => {
  test('supports __proto__ as function parameter, let binding, StoragePath.bind key, and match wildcard', () => {
    const paramAllow = evalDirectStorage("check('ok')", {
      serviceFns: "function check(__proto__) { return __proto__ == 'ok'; }",
    });
    expect(paramAllow.decision).toBe('ALLOW');

    const paramDeny = evalDirectStorage("check('other')", {
      serviceFns: "function check(__proto__) { return __proto__ == 'ok'; }",
    });
    expect(paramDeny.decision).toBe('DENY');

    const letAllow = evalDirectStorage('check()', {
      serviceFns: "function check() { let __proto__ = 'ok'; return __proto__ == 'ok'; }",
    });
    expect(letAllow.decision).toBe('ALLOW');

    const bindAllow = evalDirectStorage(
      "path('/items/{__proto__}').bind({'__proto__': 'ok'}) == path('/items/ok')",
    );
    expect(bindAllow.decision).toBe('ALLOW');

    const bindIndexAllow = evalDirectStorage(
      "path('/items/{__proto__}').bind({'__proto__': 'ok'})['__proto__'] == 'ok'",
    );
    expect(bindIndexAllow.decision).toBe('ALLOW');

    const singleWildcardAllow = evalDirectStorage("__proto__ == 'ok'", {
      matchPath: '/items/{__proto__}',
      path: 'items/ok',
    });
    expect(singleWildcardAllow.decision).toBe('ALLOW');

    const singleWildcardDeny = evalDirectStorage("__proto__ == 'ok'", {
      matchPath: '/items/{__proto__}',
      path: 'items/other',
    });
    expect(singleWildcardDeny.decision).toBe('DENY');

    const recursiveWildcardAllow = evalDirectStorage('__proto__ == /a/b', {
      matchPath: '/tree/{__proto__=**}',
      path: 'tree/a/b',
    });
    expect(recursiveWildcardAllow.decision).toBe('ALLOW');
  });
});
