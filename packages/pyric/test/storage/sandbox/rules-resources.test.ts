import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

const METADATA_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow read: if resource.metadata.owner == request.auth.uid;
      allow write: if request.resource.metadata.owner == request.auth.uid;
    }
  }
}`;

describe('evaluateStorageRules — metadata bindings (#764)', () => {
  const rules = parseStorageRules(METADATA_RULES);
  const path = 'b/pyric-default/o/docs/d1.json';

  it('allows a read when resource.metadata.owner matches request.auth.uid', () => {
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path },
      resource: { size: 12, metadata: { owner: 'alice' } },
    });
    expect(r.allowed).toBe(true);
  });

  it('denies a read when resource.metadata.owner is a different user', () => {
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'bob' }, method: 'read', path },
      resource: { size: 12, metadata: { owner: 'alice' } },
    });
    expect(r.allowed).toBe(false);
  });

  it('denies an anonymous read against resource.metadata.owner', () => {
    const r = evaluateStorageRules(rules, {
      request: { auth: null, method: 'read', path },
      resource: { size: 12, metadata: { owner: 'alice' } },
    });
    expect(r.allowed).toBe(false);
  });

  it('allows a write when request.resource.metadata.owner matches request.auth.uid', () => {
    const r = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'alice' },
        method: 'write',
        path,
        resource: { size: 2, contentType: 'application/json', metadata: { owner: 'alice' } },
      },
      resource: null,
    });
    expect(r.allowed).toBe(true);
  });

  it('denies a write claiming another user in request.resource.metadata.owner', () => {
    const r = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'bob' },
        method: 'write',
        path,
        resource: { size: 2, contentType: 'application/json', metadata: { owner: 'alice' } },
      },
      resource: null,
    });
    expect(r.allowed).toBe(false);
  });

  it('denies an anonymous write against request.resource.metadata.owner', () => {
    const r = evaluateStorageRules(rules, {
      request: {
        auth: null,
        method: 'write',
        path,
        resource: { size: 2, contentType: 'application/json', metadata: { owner: 'alice' } },
      },
      resource: null,
    });
    expect(r.allowed).toBe(false);
  });
});

// ─── Custom metadata: dotted AND bracket access ──────────────────
//
// Custom metadata is a flat string→string map. Both `resource.metadata.owner`
// (dotted) and `resource.metadata['owner']` (bracket) must resolve to the
// same value; a missing key resolves to undefined and denies (never a false
// allow).

describe('evaluateStorageRules — custom metadata access forms', () => {
  const path = 'b/pyric-default/o/docs/d1.json';

  function evalRead(cond: string, metadata: Record<string, string>, uid: string): boolean {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} { allow read: if ${cond}; }
      }
    }`);
    return evaluateStorageRules(rules, {
      request: { auth: { uid }, method: 'read', path },
      resource: { size: 3, metadata },
    }).allowed;
  }

  it('resolves dotted metadata access', () => {
    expect(evalRead("resource.metadata.owner == request.auth.uid", { owner: 'alice' }, 'alice')).toBe(true);
  });

  it('resolves bracket metadata access identically to dotted', () => {
    expect(evalRead("resource.metadata['owner'] == request.auth.uid", { owner: 'alice' }, 'alice')).toBe(true);
  });

  it('denies when the metadata key is absent (undefined, never a false allow)', () => {
    expect(evalRead("resource.metadata.owner == request.auth.uid", { other: 'alice' }, 'alice')).toBe(false);
    expect(evalRead("resource.metadata['owner'] == request.auth.uid", { other: 'alice' }, 'alice')).toBe(false);
  });

  it('supports required metadata keys through keys().hasAll()', () => {
    expect(
      evalRead(
        "resource.metadata.keys().hasAll(['owner', 'purpose'])",
        { owner: 'alice', purpose: 'avatar', extra: 'allowed' },
        'alice',
      ),
    ).toBe(true);
  });

  it('supports a default for an absent metadata key through Map.get()', () => {
    expect(
      evalRead(
        "resource.metadata.get('visibility', 'private') == 'private'",
        { owner: 'alice' },
        'alice',
      ),
    ).toBe(true);
  });

  it('does not treat boxed float values as maps or sized collections', () => {
    expect(evalRead("1.0.get('value', 0) == 1", {}, 'alice')).toBe(false);
    expect(evalRead("1.0.keys().hasAll(['value'])", {}, 'alice')).toBe(false);
    expect(evalRead('1.0.size() == 1', {}, 'alice')).toBe(false);
    expect(evalRead('1.0 is map', {}, 'alice')).toBe(false);
    expect(evalRead("'value' in 1.0", {}, 'alice')).toBe(false);
    expect(evalRead('1.0.value == 1', {}, 'alice')).toBe(false);
    expect(evalRead("1.0['value'] == 1", {}, 'alice')).toBe(false);
  });
});

describe('absent resource properties error and deny (no false-allow)', () => {
  const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{id} {
      allow get: if resource.name != 'nope';
    }
  }
}`);

  /** The regression this guards: modeling an absent field as plain `undefined`
   *  makes `undefined != 'nope'` TRUE in JavaScript, which would ALLOW. */
  it('denies `resource.name != <literal>` when name is absent', () => {
    const result = evaluateStorageRules(rules, {
      request: { auth: { uid: 'a' }, method: 'get', path: '/b/b1/o/x/1' },
      resource: { size: 10 },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/Property name is undefined/);
  });

  it('allows the same rule when name is present and differs', () => {
    const result = evaluateStorageRules(rules, {
      request: { auth: { uid: 'a' }, method: 'get', path: '/b/b1/o/x/1' },
      resource: { size: 10, name: 'x/1' },
    });
    expect(result.allowed).toBe(true);
  });

  it('denies a property read through a null resource (create with no object)', () => {
    const result = evaluateStorageRules(rules, {
      request: { auth: { uid: 'a' }, method: 'get', path: '/b/b1/o/x/1' },
      resource: null,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/Null value error/);
  });
});
