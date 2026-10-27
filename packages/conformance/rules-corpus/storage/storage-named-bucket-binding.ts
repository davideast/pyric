/**
 * H2 candidate (ST-H2-4). What `{bucket}`, request.resource.bucket and a
 * bucket-literal match bind to: the real bucket name. pyric's in-process
 * evaluator honors `bucket` on a case, so it agrees with production here; the
 * defect is in the sandbox planes, which evaluate every client operation
 * against 'pyric-default' whatever the app's storageBucket is
 * (repros/H2/rules-bucket-name.ts). This capture pins the production side.
 *
 * pyric's sandbox planes (app storageBucket = demo-pyric.appspot.com) decide
 * DENY for every case marked ALLOW here.
 */
import type { StorageScenarioRecord } from './types.ts';

const BUCKET = 'demo-pyric.appspot.com';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H2-BUCKET-BINDING',
  rationale:
    'Pin that the bucket wildcard, request.resource.bucket and resource.bucket carry the real bucket name, so a ruleset that names its bucket is honored.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /wild/{f} { allow read, write: if bucket == '${BUCKET}'; }
    match /incoming/{f} { allow write: if request.resource.bucket == '${BUCKET}'; }
    match /stored/{f} { allow read: if resource.bucket == '${BUCKET}'; }
  }
}`,
  cases: [
    { description: 'wildcard binds the real bucket name', expectation: 'ALLOW', method: 'create', path: 'wild/a.bin', bucket: BUCKET, resource: { size: 1, bucket: BUCKET, name: 'wild/a.bin' } },
    { description: 'wildcard in another bucket does not equal the name', expectation: 'DENY', method: 'create', path: 'wild/a.bin', bucket: 'other-bucket', resource: { size: 1, bucket: 'other-bucket', name: 'wild/a.bin' } },
    { description: 'request.resource.bucket is the real bucket name', expectation: 'ALLOW', method: 'create', path: 'incoming/a.bin', bucket: BUCKET, resource: { size: 1, bucket: BUCKET, name: 'incoming/a.bin' } },
    { description: 'resource.bucket is the real bucket name', expectation: 'ALLOW', method: 'get', path: 'stored/a.bin', bucket: BUCKET, existingResource: { size: 1, bucket: BUCKET, name: 'stored/a.bin' } },
  ],
};
