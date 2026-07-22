/** Distinguishing witness for nested Firestore match composition. */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'CDD: hierarchical match cascade',
  rationale:
    'A nested match must resolve relative to its parent: the exact child path allows while the parent, a sibling, and an extra descendant deny.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /parents/{parentId} {
      match /children/{childId} {
        allow get: if true;
      }
    }
  }
}`,
  cases: [
    {
      description: 'exact nested child path ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'parents/p1/children/c1',
      resource: { value: 1 },
    },
    {
      description: 'parent path without child DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'parents/p1',
      resource: { value: 1 },
    },
    {
      description: 'sibling path outside nested match DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'parents/p1/siblings/s1',
      resource: { value: 1 },
    },
    {
      description: 'descendant beyond exact nested match DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'parents/p1/children/c1/grandchildren/g1',
      resource: { value: 1 },
    },
  ],
  group: 'fix-class',
};
