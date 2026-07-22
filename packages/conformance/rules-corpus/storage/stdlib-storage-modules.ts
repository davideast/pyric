/**
 * Storage-library admission probe: the exact deployable function bodies in
 * storage/uploads, storage/metadata, storage/objects, and storage/time.
 * Resolver tests separately prove that 2+modules lowers the authored exports
 * to this plain-v2 shape.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-NATIVE-STDLIB',
  rationale:
    'Exact four-module Storage stdlib bodies: upload bounds, MIME policy, custom metadata, operation identity, and strict object timestamp windows.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function sizeAtMost(maxBytes) {
      return request.resource.size <= maxBytes;
    }
    function sizeBetween(minBytes, maxBytes) {
      return request.resource.size >= minBytes
        && request.resource.size <= maxBytes;
    }
    function contentTypeMatches(pattern) {
      return request.resource.contentType.matches(pattern);
    }
    function contentTypeIsOneOf(types) {
      return request.resource.contentType in types;
    }
    function hasRequiredMetadata(keys) {
      return request.resource.metadata.keys().hasAll(keys);
    }
    function metadataString(key, min, max) {
      return request.resource.metadata[key] is string
        && request.resource.metadata[key].size() >= min
        && request.resource.metadata[key].size() <= max;
    }
    function incomingMetadataOwner(key) {
      return request.auth != null
        && request.resource.metadata[key] == request.auth.uid;
    }
    function existingMetadataOwner(key) {
      return request.auth != null
        && resource.metadata[key] == request.auth.uid;
    }
    function isCreate() {
      return request.method == 'create';
    }
    function isUpdate() {
      return request.method == 'update';
    }
    function isDelete() {
      return request.method == 'delete';
    }
    function createdWithin(seconds) {
      return request.time < resource.timeCreated + duration.value(seconds, 's');
    }
    function updatedWithin(seconds) {
      return request.time < resource.updated + duration.value(seconds, 's');
    }

    match /uploads/{fileId} {
      allow create: if sizeAtMost(10)
        && sizeBetween(1, 10)
        && contentTypeMatches('image/(png|jpeg)')
        && contentTypeIsOneOf(['image/png', 'image/jpeg']);
    }
    match /metadata/{fileId} {
      allow create: if hasRequiredMetadata(['owner', 'purpose'])
        && metadataString('purpose', 3, 12)
        && incomingMetadataOwner('owner');
      allow update: if existingMetadataOwner('owner');
    }
    match /objects/{fileId} {
      allow create: if isCreate();
      allow update: if isUpdate();
      allow delete: if isDelete();
    }
    match /created/{fileId} {
      allow delete: if createdWithin(60);
    }
    match /updated/{fileId} {
      allow delete: if updatedWithin(30);
    }
  }
}`,
  cases: [
    { description: 'uploads: inclusive bounds and exact MIME allow', expectation: 'ALLOW', method: 'create', path: 'uploads/a.png', resource: { size: 10, contentType: 'image/png' } },
    { description: 'uploads: zero bytes deny lower bound', expectation: 'DENY', method: 'create', path: 'uploads/a.png', resource: { size: 0, contentType: 'image/png' } },
    { description: 'uploads: one byte over denies upper bound', expectation: 'DENY', method: 'create', path: 'uploads/a.png', resource: { size: 11, contentType: 'image/png' } },
    { description: 'uploads: parameterized MIME denies exact allowlist', expectation: 'DENY', method: 'create', path: 'uploads/a.png', resource: { size: 5, contentType: 'image/png; charset=binary' } },
    { description: 'metadata: required string metadata and owner allow', expectation: 'ALLOW', method: 'create', path: 'metadata/a.bin', auth: { uid: 'alice' }, resource: { size: 1, metadata: { owner: 'alice', purpose: 'avatar', extra: 'ok' } } },
    { description: 'metadata: missing required key denies', expectation: 'DENY', method: 'create', path: 'metadata/a.bin', auth: { uid: 'alice' }, resource: { size: 1, metadata: { owner: 'alice' } } },
    { description: 'metadata: non-owner create denies', expectation: 'DENY', method: 'create', path: 'metadata/a.bin', auth: { uid: 'bob' }, resource: { size: 1, metadata: { owner: 'alice', purpose: 'avatar' } } },
    { description: 'metadata: existing owner update allows', expectation: 'ALLOW', method: 'update', path: 'metadata/a.bin', auth: { uid: 'alice' }, resource: { size: 1, metadata: { owner: 'alice' } }, existingResource: { size: 1, metadata: { owner: 'alice' } } },
    { description: 'objects: create identity allows create', expectation: 'ALLOW', method: 'create', path: 'objects/a.bin', resource: { size: 1 } },
    { description: 'objects: update identity allows update', expectation: 'ALLOW', method: 'update', path: 'objects/a.bin', resource: { size: 1 }, existingResource: { size: 1 } },
    { description: 'objects: delete identity allows delete', expectation: 'ALLOW', method: 'delete', path: 'objects/a.bin', existingResource: { size: 1 } },
    { description: 'created time: just before strict deadline allows', expectation: 'ALLOW', method: 'delete', path: 'created/a.bin', existingResource: { size: 1, timeCreated: '2026-07-21T00:00:00.000Z' }, requestTime: '2026-07-21T00:00:59.999Z' },
    { description: 'created time: exact deadline denies', expectation: 'DENY', method: 'delete', path: 'created/a.bin', existingResource: { size: 1, timeCreated: '2026-07-21T00:00:00.000Z' }, requestTime: '2026-07-21T00:01:00.000Z' },
    { description: 'updated time: just before strict deadline allows', expectation: 'ALLOW', method: 'delete', path: 'updated/a.bin', existingResource: { size: 1, updated: '2026-07-21T00:00:30.000Z' }, requestTime: '2026-07-21T00:00:59.999Z' },
    { description: 'updated time: exact deadline denies', expectation: 'DENY', method: 'delete', path: 'updated/a.bin', existingResource: { size: 1, updated: '2026-07-21T00:00:30.000Z' }, requestTime: '2026-07-21T00:01:00.000Z' },
  ],
};
