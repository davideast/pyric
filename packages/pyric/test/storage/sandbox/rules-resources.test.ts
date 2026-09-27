import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';
import { requestResourceFor, resourceFromStored } from '../../../src/storage/sandbox/rules-resources.js';

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

  it('does not expose JavaScript prototype properties as metadata keys', () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(evalRead(`resource.metadata.${key} != null`, {}, 'alice'), key).toBe(false);
      expect(evalRead(`resource.metadata['${key}'] != null`, {}, 'alice'), key).toBe(false);
    }
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

describe('request.resource carries the fields production builds for a write', () => {
  const stored = {
    fullPath: 'users/alice/a.txt',
    name: 'a.txt',
    bucket: 'pyric-default',
    size: 2,
    contentType: 'text/plain',
    generation: '1700000000000000',
    metageneration: '3',
    timeCreated: '2025-03-01T00:00:00.000Z',
    updated: '2025-03-02T00:00:00.000Z',
  };

  it('an upload carries identity, settable fields with upload defaults, and null version fields', () => {
    expect(requestResourceFor(stored, 'upload')).toEqual({
      name: 'users/alice/a.txt',
      bucket: 'pyric-default',
      size: 2,
      contentType: 'text/plain',
      contentDisposition: "inline; filename*=utf-8''a.txt",
      contentEncoding: 'identity',
      contentLanguage: null,
      cacheControl: null,
      metadata: null,
      generation: null,
      metageneration: null,
      etag: null,
    });
  });

  it('an upload keeps the settable fields the client sets', () => {
    const resource = requestResourceFor({
      ...stored,
      contentDisposition: 'attachment',
      contentEncoding: 'gzip',
      contentLanguage: 'en',
      cacheControl: 'no-cache',
      customMetadata: { owner: 'alice' },
    }, 'upload');
    expect(resource).toMatchObject({
      contentDisposition: 'attachment',
      contentEncoding: 'gzip',
      contentLanguage: 'en',
      cacheControl: 'no-cache',
      metadata: { owner: 'alice' },
    });
  });

  it('a metadata update carries the stored versions, identity for an unset contentEncoding, and null for other unset settable fields', () => {
    expect(requestResourceFor(stored, 'metadataUpdate')).toEqual({
      name: 'users/alice/a.txt',
      bucket: 'pyric-default',
      size: 2,
      contentType: 'text/plain',
      contentDisposition: null,
      contentEncoding: 'identity',
      contentLanguage: null,
      cacheControl: null,
      metadata: null,
      generation: 1700000000000000,
      metageneration: 3,
    });
  });

  it('neither write carries timeCreated or updated', () => {
    for (const write of ['upload', 'metadataUpdate'] as const) {
      const resource = requestResourceFor(stored, write);
      expect(Object.hasOwn(resource, 'timeCreated')).toBe(false);
      expect(Object.hasOwn(resource, 'updated')).toBe(false);
    }
  });

  const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{file} {
      allow create: if request.resource.name == 'users/alice/a.txt'
        && request.resource.name.split('/')[1] == request.auth.uid
        && request.resource.bucket == bucket
        && request.resource.generation == null
        && request.resource.metadata == null;
      allow update: if request.resource.name == resource.name
        && request.resource.bucket == resource.bucket
        && request.resource.generation == resource.generation
        && request.resource.metageneration == resource.metageneration;
    }
    match /times/{file} {
      allow create, update: if request.resource.timeCreated != request.time;
    }
  }
}`);

  it('a create rule reads request.resource.name and .bucket', () => {
    const result = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'alice' }, method: 'create', path: '/b/pyric-default/o/users/alice/a.txt',
        resource: requestResourceFor(stored, 'upload'),
      },
      resource: null,
    });
    expect(result.reasons).toEqual([]);
    expect(result.allowed).toBe(true);
  });

  it('a metadata update rule compares request.resource identity and versions with resource', () => {
    const result = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'alice' }, method: 'update', path: '/b/pyric-default/o/users/alice/a.txt',
        resource: requestResourceFor(stored, 'metadataUpdate'),
      },
      resource: resourceFromStored(stored),
    });
    expect(result.reasons).toEqual([]);
    expect(result.allowed).toBe(true);
  });

  it('reading request.resource.timeCreated errors and denies, even under negation', () => {
    const timed = { ...stored, fullPath: 'times/t.txt' };
    for (const [method, write, existing] of [
      ['create', 'upload', null],
      ['update', 'metadataUpdate', resourceFromStored(timed)],
    ] as const) {
      const result = evaluateStorageRules(rules, {
        request: {
          auth: { uid: 'alice' }, method, path: '/b/pyric-default/o/times/t.txt',
          resource: requestResourceFor(timed, write),
        },
        resource: existing,
      });
      expect(result.allowed).toBe(false);
      expect(result.reasons.join(' ')).toMatch(/Property timeCreated is undefined/);
    }
  });
});
