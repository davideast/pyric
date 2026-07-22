/**
 * P2 discovery probe for candidate Storage-native stdlib primitives. One
 * batched Rules Test API request covers the boundaries that helpers would
 * otherwise be tempted to guess: inclusive size limits, MIME exactness,
 * metadata key/default methods, unchanged bytes during metadata updates,
 * path wildcard typing, object identity, and strict time windows.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-P2-PRIMITIVES',
  rationale:
    'Boundary-first evidence for Storage size, MIME, metadata, path, identity, and time helpers, including production-pinned metadata collection methods.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function sizeAtMost(maxBytes) {
      return request.resource.size <= maxBytes;
    }
    function mimeIs(expected) {
      return request.resource.contentType == expected;
    }
    function hasMetadata(required) {
      return request.resource.metadata.keys().hasAll(required);
    }
    function metadataOr(key, fallback) {
      return request.resource.metadata.get(key, fallback);
    }
    function createdWithin(seconds) {
      return request.time < resource.timeCreated + duration.value(seconds, 's');
    }

    match /size/{fileName} {
      allow create: if sizeAtMost(10);
    }
    match /mime-exact/{fileName} {
      allow create: if mimeIs('image/png');
    }
    match /mime-regex/{fileName} {
      allow create: if request.resource.contentType.matches('image/(png|jpeg)');
    }
    match /metadata-required/{fileName} {
      allow create: if hasMetadata(['owner', 'purpose']);
    }
    match /metadata-default/{fileName} {
      allow create: if metadataOr('visibility', 'private') == 'private';
    }
    match /metadata-update/{fileName} {
      allow update: if request.resource.size == resource.size
        && request.resource.metadata.owner == resource.metadata.owner;
    }
    match /path/{fileName} {
      allow create: if fileName is string && fileName.matches('.*[.]png');
    }
    match /identity/{fileName} {
      allow get: if resource.name == 'identity/pinned.png'
        && resource.bucket == bucket
        && resource.generation == 7
        && resource.metageneration == 2;
    }
    match /fresh/{fileName} {
      allow delete: if createdWithin(60);
    }
    match /request-resource-delete/{fileName} {
      allow delete: if request.resource == null;
    }
  }
}`,
  cases: [
    { description: 'size: zero bytes is within inclusive maximum', expectation: 'ALLOW', method: 'create', path: 'size/zero.bin', resource: { size: 0 } },
    { description: 'size: exact maximum is allowed', expectation: 'ALLOW', method: 'create', path: 'size/exact.bin', resource: { size: 10 } },
    { description: 'size: maximum plus one is denied', expectation: 'DENY', method: 'create', path: 'size/large.bin', resource: { size: 11 } },

    { description: 'MIME exact: image/png is allowed', expectation: 'ALLOW', method: 'create', path: 'mime-exact/a.png', resource: { size: 1, contentType: 'image/png' } },
    { description: 'MIME exact: case difference is denied', expectation: 'DENY', method: 'create', path: 'mime-exact/a.png', resource: { size: 1, contentType: 'Image/PNG' } },
    { description: 'MIME exact: parameterized value is denied', expectation: 'DENY', method: 'create', path: 'mime-exact/a.png', resource: { size: 1, contentType: 'image/png; charset=binary' } },
    { description: 'MIME regex: image/jpeg whole value is allowed', expectation: 'ALLOW', method: 'create', path: 'mime-regex/a.jpg', resource: { size: 1, contentType: 'image/jpeg' } },
    { description: 'MIME regex: suffix defeats whole-string match', expectation: 'DENY', method: 'create', path: 'mime-regex/a.jpg', resource: { size: 1, contentType: 'image/jpeg-extra' } },

    { description: 'metadata keys: required keys with an extra key are allowed', expectation: 'ALLOW', method: 'create', path: 'metadata-required/a.bin', resource: { size: 1, metadata: { owner: 'alice', purpose: 'avatar', extra: 'ok' } } },
    { description: 'metadata keys: missing required key is denied', expectation: 'DENY', method: 'create', path: 'metadata-required/a.bin', resource: { size: 1, metadata: { owner: 'alice' } } },
    { description: 'metadata keys: absent metadata map is denied', expectation: 'DENY', method: 'create', path: 'metadata-required/a.bin', resource: { size: 1 } },
    { description: 'metadata get: missing key returns supplied default', expectation: 'ALLOW', method: 'create', path: 'metadata-default/a.bin', resource: { size: 1, metadata: {} } },
    { description: 'metadata get: present non-default value is denied', expectation: 'DENY', method: 'create', path: 'metadata-default/a.bin', resource: { size: 1, metadata: { visibility: 'public' } } },

    { description: 'metadata update: unchanged bytes and owner are allowed', expectation: 'ALLOW', method: 'update', path: 'metadata-update/a.bin', resource: { size: 8, metadata: { owner: 'alice', label: 'new' } }, existingResource: { size: 8, metadata: { owner: 'alice', label: 'old' } } },
    { description: 'metadata update: changed byte size is denied', expectation: 'DENY', method: 'update', path: 'metadata-update/a.bin', resource: { size: 9, metadata: { owner: 'alice' } }, existingResource: { size: 8, metadata: { owner: 'alice' } } },
    { description: 'metadata update: changed owner is denied', expectation: 'DENY', method: 'update', path: 'metadata-update/a.bin', resource: { size: 8, metadata: { owner: 'bob' } }, existingResource: { size: 8, metadata: { owner: 'alice' } } },

    { description: 'path wildcard: string png filename is allowed', expectation: 'ALLOW', method: 'create', path: 'path/photo.png', resource: { size: 1 } },
    { description: 'path wildcard: non-png filename is denied', expectation: 'DENY', method: 'create', path: 'path/photo.jpg', resource: { size: 1 } },

    { description: 'identity: exact name bucket generation and metageneration are allowed', expectation: 'ALLOW', method: 'get', path: 'identity/pinned.png', existingResource: { size: 1, name: 'identity/pinned.png', bucket: 'demo-pyric.appspot.com', generation: 7, metageneration: 2 } },
    { description: 'identity: generation mismatch is denied', expectation: 'DENY', method: 'get', path: 'identity/pinned.png', existingResource: { size: 1, name: 'identity/pinned.png', bucket: 'demo-pyric.appspot.com', generation: 8, metageneration: 2 } },
    { description: 'identity: absent generation is denied', expectation: 'DENY', method: 'get', path: 'identity/pinned.png', existingResource: { size: 1, name: 'identity/pinned.png', bucket: 'demo-pyric.appspot.com', metageneration: 2 } },

    { description: 'time: one millisecond before strict 60 second boundary is allowed', expectation: 'ALLOW', method: 'delete', path: 'fresh/a.bin', requestTime: '2025-03-01T00:00:59.999Z', existingResource: { size: 1, timeCreated: '2025-03-01T00:00:00Z' } },
    { description: 'time: exact strict 60 second boundary is denied', expectation: 'DENY', method: 'delete', path: 'fresh/a.bin', requestTime: '2025-03-01T00:01:00Z', existingResource: { size: 1, timeCreated: '2025-03-01T00:00:00Z' } },
    { description: 'time: after strict 60 second boundary is denied', expectation: 'DENY', method: 'delete', path: 'fresh/a.bin', requestTime: '2025-03-01T00:01:00.001Z', existingResource: { size: 1, timeCreated: '2025-03-01T00:00:00Z' } },
    { description: 'time: future timeCreated value makes the strict comparison true', expectation: 'ALLOW', method: 'delete', path: 'fresh/a.bin', requestTime: '2025-03-01T00:00:00Z', existingResource: { size: 1, timeCreated: '2025-03-01T00:01:00Z' } },
    { description: 'delete: missing request.resource does not become a usable null guard', expectation: 'DENY', method: 'delete', path: 'request-resource-delete/a.bin', existingResource: { size: 1 } },
  ],
};
