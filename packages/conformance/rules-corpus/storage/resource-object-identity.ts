/**
 * ─── Scenario: resource-object-identity ─────────────────────────────────────
 * The object-identity / time fields of the `resource` binding: `name`,
 * `timeCreated`, `updated`, `bucket`. These are the fields real Storage rules
 * lean on — extension guards (`resource.name.matches(…)`), freshness windows
 * (`resource.timeCreated + duration.value(1, 'h')`), and immutability checks
 * (`resource.timeCreated == resource.updated`).
 *
 * Replaces the earlier `resource-timestamp-witness` scenario, which recorded
 * these fields as UNMODELED (its cases read `undefined` and denied). They are
 * modeled now, sourced from the persisted object record, so this scenario
 * asserts them for real — every case is checked against production's verdict,
 * none is a `knownGap`.
 *
 * PRODUCTION SEMANTICS THIS PINS (each live-probed against the Rules Test API):
 *
 *   - `resource` is a LITERAL map on the wire: production derives NOTHING from
 *     the request path. A case that omits `name` and whose rule reads
 *     `resource.name` gets "Property name is undefined on object." — hence the
 *     absent-`name` case below.
 *   - An absent property is an evaluation ERROR that absorbs to DENY, and it
 *     SURVIVES NEGATION: the `/guarded` cases pin `resource.name != 'nope'`
 *     denying when `name` is absent. Modeling the field as a plain `undefined`
 *     would make that comparison `true` and FALSE-ALLOW.
 *   - `timeCreated` / `updated` are TIMESTAMPS: they must go over the wire as
 *     ISO-8601 strings (production rejects an int with "Unsupported operation
 *     error. Received: int < timestamp").
 *   - The update-time field is `updated`. There is NO `resource.timeUpdated`.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-RES-IDENTITY',
  rationale:
    'The resource binding\'s object-identity/time fields — name (full object path), timeCreated, updated, bucket — driving an extension guard, a freshness window, an immutability check, and an absent-property negation that must not false-allow.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileId} {
      // Extension guard: only image objects are readable.
      allow get: if resource.name.matches('.*[.](png|jpg)');
      // Freshness: an object may be deleted only within an hour of creation.
      allow delete: if request.time < resource.timeCreated + duration.value(1, 'h');
      // Immutability: a metadata update is allowed only while the object has
      // never been modified, and only in its own bucket.
      allow update: if resource.timeCreated == resource.updated
        && resource.bucket == bucket;
    }
    match /guarded/{fileId} {
      // Negation over an absent property must NOT false-allow.
      allow get: if resource.name != 'nope';
    }
  }
}`,
  cases: [
    {
      description: 'get: resource.name ends in .png → allow (extension guard)',
      expectation: 'ALLOW', method: 'get', path: 'uploads/pic.png',
      existingResource: { size: 10, name: 'uploads/pic.png' },
    },
    {
      description: 'get: resource.name ends in .txt → deny (extension guard)',
      expectation: 'DENY', method: 'get', path: 'uploads/notes.txt',
      existingResource: { size: 10, name: 'uploads/notes.txt' },
    },
    {
      description: 'get: resource.name absent → deny (absent-property error, no false-allow)',
      expectation: 'DENY', method: 'get', path: 'uploads/pic.png',
      existingResource: { size: 10 },
    },
    {
      description: 'delete: within 1h of timeCreated → allow (freshness)',
      expectation: 'ALLOW', method: 'delete', path: 'uploads/pic.png', requestTime: '2025-03-01T00:30:00Z',
      existingResource: { size: 10, name: 'uploads/pic.png', timeCreated: '2025-03-01T00:00:00Z', updated: '2025-03-01T00:00:00Z' },
    },
    {
      description: 'delete: more than 1h after timeCreated → deny (freshness)',
      expectation: 'DENY', method: 'delete', path: 'uploads/pic.png', requestTime: '2025-03-01T02:00:00Z',
      existingResource: { size: 10, name: 'uploads/pic.png', timeCreated: '2025-03-01T00:00:00Z', updated: '2025-03-01T00:00:00Z' },
    },
    {
      description: 'update: timeCreated == updated (never modified) → allow (immutability)',
      expectation: 'ALLOW', method: 'update', path: 'uploads/pic.png', resource: { size: 20 },
      existingResource: { size: 10, name: 'uploads/pic.png', bucket: 'demo-pyric.appspot.com', timeCreated: '2025-03-01T00:00:00Z', updated: '2025-03-01T00:00:00Z' },
    },
    {
      description: 'update: timeCreated != updated (already modified) → deny (immutability)',
      expectation: 'DENY', method: 'update', path: 'uploads/pic.png', resource: { size: 20 },
      existingResource: { size: 10, name: 'uploads/pic.png', bucket: 'demo-pyric.appspot.com', timeCreated: '2025-03-01T00:00:00Z', updated: '2025-04-01T00:00:00Z' },
    },
    {
      description: 'get: resource.name != literal, name present → allow',
      expectation: 'ALLOW', method: 'get', path: 'guarded/g.txt',
      existingResource: { size: 10, name: 'guarded/g.txt' },
    },
    {
      description: 'get: resource.name != literal, name ABSENT → deny (error survives negation)',
      expectation: 'DENY', method: 'get', path: 'guarded/g.txt',
      existingResource: { size: 10 },
    },
  ],
};
