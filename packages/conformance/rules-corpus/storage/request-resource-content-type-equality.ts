/**
 * Storage Rules conformance scenario for `storage-rules#101`:
 * `request.resource.contentType == '<mime>'` exact string equality guard.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-REQUEST-RESOURCE-CONTENT-TYPE-EQ',
  rationale:
    'Pins exact case-sensitive MIME equality on request.resource.contentType against exact match, charset parameter, uppercase variant, different type, and omitted contentType.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow write: if request.resource.contentType == 'application/json';
    }
  }
}`,
  cases: [
    {
      description: 'exact application/json contentType allows',
      expectation: 'ALLOW',
      method: 'create',
      path: 'items/doc.json',
      resource: { size: 32, contentType: 'application/json' },
    },
    {
      description: 'charset parameter suffix denies under exact equality',
      expectation: 'DENY',
      method: 'create',
      path: 'items/doc.json',
      resource: { size: 32, contentType: 'application/json; charset=utf-8' },
    },
    {
      description: 'uppercase MIME type denies under exact equality',
      expectation: 'DENY',
      method: 'create',
      path: 'items/doc.json',
      resource: { size: 32, contentType: 'APPLICATION/JSON' },
    },
    {
      description: 'different MIME type text/plain denies',
      expectation: 'DENY',
      method: 'create',
      path: 'items/doc.json',
      resource: { size: 32, contentType: 'text/plain' },
    },
    {
      description: 'omitted contentType denies',
      expectation: 'DENY',
      method: 'create',
      path: 'items/doc.json',
      resource: { size: 32 },
    },
  ],
};
