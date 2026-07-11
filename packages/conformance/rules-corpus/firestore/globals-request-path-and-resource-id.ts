/**
 * ─── Pack 11: globals-request-path-and-resource-id ────────────────────────
 * Targets Item 6 — populates request.path / request.query / resource.id /
 * resource.__name__. Pre-fix: all four were undefined; rules touching them
 * silently denied. Each case asserts a wrapper invariant against prod so
 * any divergence (e.g. prod uses a different path canonical form) shows up
 * as SIM_BUG in the divergence accountant.
 */
import type { PackRecord } from './types.ts';

export const pack: PackRecord = {
  fm: 'Item 6',
  rationale: 'Sim must populate request.path (Path), request.query (Map), resource.id (String), resource.__name__ (Path). Pre-fix: all undefined; rules using them silently denied.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // request.path is path
    match /reqPathIsPathAllow/{id} {
      allow create: if request.auth != null
        && request.path is path;
    }
    // request.path equality with literal
    match /reqPathEqAllow/{id} {
      allow create: if request.auth != null
        && request.path == /databases/$(database)/documents/reqPathEqAllow/$(id);
    }
    // request.query is map (empty for non-list)
    match /reqQueryAllow/{id} {
      allow create: if request.auth != null
        && request.query is map
        && request.query.size() == 0;
    }
    // resource.id on a CREATE: production makes resource null (the target
    // doc does not exist pre-write), so resource.id errors and it DENYs.
    match /resourceIdOnCreateDeny/{id} {
      allow create: if request.auth != null
        && resource.id == id
        && resource.id is string;
    }
    // resource.__name__ on a CREATE: same, resource is null pre-write, so
    // resource.__name__ errors and it DENYs.
    match /resourceNameOnCreateDeny/{id} {
      allow create: if request.auth != null
        && resource.__name__ == request.path
        && resource.__name__ is path;
    }
    // DENY witness — wrong resource.id
    match /resourceIdWrongDeny/{id} {
      allow create: if request.auth != null
        && resource.id == 'definitelyNotThisId';
    }
  }
}`,
  cases: [
    {
      description: 'request.path is path ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'reqPathIsPathAllow/d1',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'request.path equals literal ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'reqPathEqAllow/d2',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'request.query empty map ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'reqQueryAllow/d3',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      // On a create the target doc does not exist yet, so `resource` is
      // null and `resource.id` errors → DENY. (Was mis-stated as ALLOW; the
      // sim previously synthesized a resource identity — a false-allow.)
      description: 'resource.id on create → DENY (resource is null pre-write)',
      expectation: 'DENY',
      method: 'create',
      path: 'resourceIdOnCreateDeny/d4',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      // Same as above for __name__: `resource` is null on create → DENY.
      description: 'resource.__name__ on create → DENY (resource is null pre-write)',
      expectation: 'DENY',
      method: 'create',
      path: 'resourceNameOnCreateDeny/d5',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'wrong resource.id DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'resourceIdWrongDeny/d6',
      auth: { uid: 'alice' },
      data: {},
    },
  ],
  group: 'stress',
};
