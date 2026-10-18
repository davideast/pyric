import { describe, expect, test } from 'bun:test';
import { Bytes } from '../../../src/rules/simulator/wrappers/bytes.js';
import { Timestamp } from '../../../src/rules/simulator/wrappers/timestamp.js';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';
import { requestResourceFor } from '../../../src/storage/sandbox/rules-resources.js';

function evalCondition(
  condition: string,
  opts: {
    globalFns?: string;
    serviceFns?: string;
    matchFns?: string;
    resource?: Record<string, unknown> | null;
    docs?: Record<string, Record<string, unknown>>;
    path?: string;
  } = {},
) {
  const rules = parseStorageRules(`rules_version = '2';
${opts.globalFns ?? ''}
service firebase.storage {
  ${opts.serviceFns ?? ''}
  match /b/{bucket}/o {
    match /docs/{docId} {
      ${opts.matchFns ?? ''}
      allow get: if ${condition};
    }
  }
}`);
  const lookup = opts.docs
    ? {
        get(p: string) {
          return Object.hasOwn(opts.docs!, p) ? opts.docs![p]! : null;
        },
        exists(p: string) {
          return Object.hasOwn(opts.docs!, p);
        },
      }
    : undefined;
  return evaluateStorageRules(
    rules,
    {
      request: {
        auth: { uid: 'alice' },
        method: 'get',
        path: opts.path ?? 'b/my-bucket/o/docs/d1',
      },
      resource: (opts.resource === undefined ? { size: 10 } : opts.resource) as never,
    },
    undefined,
    lookup,
  );
}

describe('Storage simulator hunt regressions (ST-SIM-1 .. ST-SIM-9)', () => {
  test('ST-SIM-1: unbound identifiers and Object.prototype keys produce absorbable RuleError and fail closed', () => {
    expect(evalCondition('undeclaredVar != "x"').allowed).toBe(false);
    expect(evalCondition('undeclaredVar == undeclaredVar').allowed).toBe(false);
    expect(evalCondition('!(undeclaredVar == "x")').allowed).toBe(false);
    expect(evalCondition('toString != null').allowed).toBe(false);
    expect(evalCondition('constructor != null').allowed).toBe(false);
    expect(evalCondition('valueOf != null').allowed).toBe(false);
    expect(evalCondition('(undeclaredVar == "x") || true').allowed).toBe(true);
    expect(evalCondition('!((undeclaredVar == "x") && false)').allowed).toBe(true);
  });

  test('ST-SIM-2: enforces lexical scoping across global, service, and match functions', () => {
    expect(
      evalCondition('readBucket()', {
        serviceFns: 'function readBucket() { return bucket == "my-bucket"; }',
      }).allowed,
    ).toBe(false);
    expect(
      evalCondition('!isOtherBucket()', {
        serviceFns: 'function isOtherBucket() { return bucket == "other"; }',
      }).allowed,
    ).toBe(false);
    expect(
      evalCondition('globalCheck()', {
        globalFns: 'function globalCheck() { return request.auth != null; }',
      }).allowed,
    ).toBe(false);
    expect(
      evalCondition('globalCaller()', {
        globalFns: 'function globalCaller() { return serviceHelper(); }',
        serviceFns: 'function serviceHelper() { return true; }',
      }).allowed,
    ).toBe(false);
    expect(
      evalCondition('isAlice()', {
        serviceFns: 'function isAlice() { return request.auth.uid == "alice"; }',
      }).allowed,
    ).toBe(true);
    expect(
      evalCondition('matchHelper()', {
        matchFns: 'function matchHelper() { return bucket == "my-bucket" && docId == "d1"; }',
      }).allowed,
    ).toBe(true);
    expect(
      evalCondition('!mismatchHelper()', {
        matchFns: 'function mismatchHelper() { return docId == "other"; }',
      }).allowed,
    ).toBe(true);
  });

  test('ST-SIM-3: latlng methods/bounds/dot-access and path.bind() / path() validation', () => {
    expect(evalCondition('latlng.value(37.0, -122.0).latitude() == 37.0').allowed).toBe(true);
    expect(evalCondition('latlng.value(37.0, -122.0).longitude() == -122.0').allowed).toBe(true);
    expect(evalCondition('latlng.value(0.0, 0.0).distance(latlng.value(0.0, 0.0)) == 0.0').allowed).toBe(true);
    expect(evalCondition('latlng.value(10.0, 20.0).latitude == 10.0').allowed).toBe(false);
    expect(evalCondition('latlng.value(95.0, 0.0) == latlng.value(95.0, 0.0)').allowed).toBe(false);
    expect(evalCondition('latlng.value(0.0, -185.0) == latlng.value(0.0, -185.0)').allowed).toBe(false);
    expect(evalCondition('path("/users/{uid}").bind({"uid": "alice"}) == path("/users/alice")').allowed).toBe(true);
    expect(evalCondition('path("/users/$(uid)").bind({"uid": "alice"}) == path("/users/alice")').allowed).toBe(true);
    expect(evalCondition('path(path("/a/b")) == path("/a/b")').allowed).toBe(false);
    expect(evalCondition('path("/a//b") == path("/a/b")').allowed).toBe(false);
  });

  test('ST-SIM-4: timestamp.date/value and duration.value/time integer typing and range bounds', () => {
    expect(evalCondition('timestamp.date(2025, 13, 1) == timestamp.date(2025, 1, 1)').allowed).toBe(false);
    expect(evalCondition('(timestamp.date(2025, 2, 30) == timestamp.value(0)) || true').allowed).toBe(true);
    expect(evalCondition('timestamp.date(2023, 2, 29) == timestamp.value(0)').allowed).toBe(false);
    expect(evalCondition('timestamp.date(2024, 2, 29).day() == 29').allowed).toBe(true);
    expect(evalCondition('timestamp.date(2024.5, 1, 1).year() == 2024').allowed).toBe(false);
    expect(evalCondition('timestamp.value(253402300800000) == timestamp.value(253402300800000)').allowed).toBe(false);
    expect(evalCondition('duration.value(100000000, "w") == duration.value(100000000, "w")').allowed).toBe(false);
    expect(evalCondition('duration.time(100000000, 0, 0, 0) == duration.time(100000000, 0, 0, 0)').allowed).toBe(false);
    expect(evalCondition('duration.value(1.5, "s") == duration.value(1.5, "s")').allowed).toBe(false);
  });

  test('ST-SIM-5: string.split() and string.replace() normalize RE2 syntax and scan escapes/character classes accurately', () => {
    expect(evalCondition('"AbA".split("(?i)b") == ["A", "A"]').allowed).toBe(true);
    expect(evalCondition('"AbA".replace("(?i)a", "x") == "xbx"').allowed).toBe(true);
    expect(evalCondition('"abc".replace("(?P<g>b)", "${g}!") == "ab!c"').allowed).toBe(true);
    expect(evalCondition('"a]b".split("[]a]") == ["", "", "b"]').allowed).toBe(true);
    expect(evalCondition('"bAb".replace("\\\\A.", "X") == "XAb"').allowed).toBe(true);
    expect(evalCondition('"bAb".replace("\\\\AA", "X") == "bAb"').allowed).toBe(true);
    expect(evalCondition('"\\\\1".split("\\\\\\\\1") == ["", ""]').allowed).toBe(true);
    expect(evalCondition('"(?=".split("[(?=]+") == ["", ""]').allowed).toBe(true);
    expect(evalCondition('"[(?=]".split("[(?=]+") == ["[", "]"]').allowed).toBe(true);
  });

  test('ST-SIM-6: map.get(listOfKeys, default) walks nested maps and validates key list element types', () => {
    expect(evalCondition('{"a": {"b": 42}}.get(["a", "b"], 0) == 42').allowed).toBe(true);
    expect(evalCondition('{"a": {"b": 42}}.get(["a", "missing"], 99) == 99').allowed).toBe(true);
    expect(evalCondition('{"a": 1}.get(["a", "b"], 99) == 99').allowed).toBe(true);
    expect(evalCondition('{"a": {"b": 42}}.get(["a", 123], 99) == 99').allowed).toBe(false);
    expect(evalCondition('{"a": {"b": 42}}.get(["a", 123], 99) == 99 || true').allowed).toBe(true);
  });

  test('ST-SIM-7: {name=**} binds StoragePath, matches trailing segments, and splits suffixes into nested child matches', () => {
    const globRules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /wild/{allPaths=**} {
      allow get: if allPaths is path && !(allPaths is list) && allPaths == path("/a/b/c.txt") && allPaths[0] == "a";
    }
    match /tail/{prefix=**}/items/{id} {
      allow get: if id == "item42" && prefix == path("/x/y");
    }
    match /nested/{docPath=**} {
      match /notes/{noteId} {
        allow get: if noteId == "n1" && docPath == path("/u1/p1");
      }
    }
  }
}`);
    expect(
      evaluateStorageRules(globRules, {
        request: { auth: { uid: 'alice' }, method: 'get', path: 'b/my-bucket/o/wild/a/b/c.txt' },
        resource: { size: 1 },
      }).allowed,
    ).toBe(true);
    expect(
      evaluateStorageRules(globRules, {
        request: { auth: { uid: 'alice' }, method: 'get', path: 'b/my-bucket/o/tail/x/y/items/item42' },
        resource: { size: 1 },
      }).allowed,
    ).toBe(true);
    expect(
      evaluateStorageRules(globRules, {
        request: { auth: { uid: 'alice' }, method: 'get', path: 'b/my-bucket/o/tail/x/y/other/item42' },
        resource: { size: 1 },
      }).allowed,
    ).toBe(false);
    expect(
      evaluateStorageRules(globRules, {
        request: { auth: { uid: 'alice' }, method: 'get', path: 'b/my-bucket/o/nested/u1/p1/notes/n1' },
        resource: { size: 1 },
      }).allowed,
    ).toBe(true);
  });

  test('ST-SIM-8: Firestore 2-lookup budget stops evaluation, Path arg is required and absorbable, and wrapFirestoreValue preserves types', () => {
    const budgetRules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow get: if firestore.exists(/databases/(default)/documents/users/u1)
                 && firestore.exists(/databases/(default)/documents/users/u2)
                 && firestore.exists(/databases/(default)/documents/users/u3);
      allow get: if true;
    }
  }
}`);
    const docs = {
      'users/u1': { ok: true },
      'users/u2': { ok: true },
      'users/u3': { ok: true },
      'users/alice': {
        ts: Timestamp.fromMillis(1700000000000),
        raw: Bytes.fromUtf8('hello'),
        score: 3.14,
        plainMapWithPath: { path: '/some/string', label: 'ok' },
        plainMapWithLatLng: { latitude: 10, longitude: 20, name: 'spot' },
      },
    };
    const lookup = {
      get: (p: string) => (Object.hasOwn(docs, p) ? (docs as any)[p] : null),
      exists: (p: string) => Object.hasOwn(docs, p),
    };
    expect(
      evaluateStorageRules(
        budgetRules,
        { request: { auth: { uid: 'alice' }, method: 'get', path: 'b/my-bucket/o/docs/d1' }, resource: { size: 10 } },
        undefined,
        lookup,
      ).allowed,
    ).toBe(false);

    expect(evalCondition('firestore.exists("/databases/(default)/documents/users/alice")', { docs }).allowed).toBe(false);
    expect(evalCondition('firestore.exists("/databases/(default)/documents/users/alice") || true', { docs }).allowed).toBe(true);
    expect(evalCondition('firestore.exists(null) || true', { docs }).allowed).toBe(true);
    expect(
      evalCondition(
        'firestore.get(/databases/(default)/documents/users/alice).data.ts is timestamp'
          + ' && firestore.get(/databases/(default)/documents/users/alice).data.raw is bytes'
          + ' && firestore.get(/databases/(default)/documents/users/alice).data.score is float'
          + ' && firestore.get(/databases/(default)/documents/users/alice).data.plainMapWithPath is map'
          + ' && firestore.get(/databases/(default)/documents/users/alice).data.plainMapWithPath.label == "ok"'
          + ' && firestore.get(/databases/(default)/documents/users/alice).data.plainMapWithLatLng is map'
          + ' && firestore.get(/databases/(default)/documents/users/alice).data.plainMapWithLatLng.name == "spot"',
        { docs },
      ).allowed,
    ).toBe(true);
  });

  test('ST-SIM-9: omits undefined keys from resource and request.resource maps', () => {
    expect(
      evalCondition('"metadata" in resource', {
        resource: { size: 100, contentType: 'text/plain' },
      }).allowed,
    ).toBe(false);
    expect(
      evalCondition('resource.keys().size() == 2', {
        resource: { size: 100, contentType: 'text/plain' },
      }).allowed,
    ).toBe(true);
    expect(
      evalCondition('resource.get("metadata", "fallback") == "fallback"', {
        resource: { size: 100, contentType: 'text/plain' },
      }).allowed,
    ).toBe(true);
    expect(
      evalCondition('resource.get("metadata", "fallback") != "fallback"', {
        resource: { size: 100, contentType: 'text/plain' },
      }).allowed,
    ).toBe(false);

    const reqRes = requestResourceFor(
      { fullPath: 'b/my-bucket/o/docs/d1', bucket: 'my-bucket', size: 50 },
      'upload',
    );
    expect('contentType' in reqRes).toBe(false);
    expect(reqRes.generation).toBeNull();
  });
});
