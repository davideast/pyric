import { describe, expect, it } from 'bun:test';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import {
  collectOptimisticFieldScalars,
  inspectRetainedRules,
  normalizeDatabaseRootAst,
  projectCollectionGroupAst,
} from '../../../src/assurance-surface/passes/static-query-proof-rules.js';

describe('static-query-proof-rules', () => {
  it('normalizes literal named-database root matches only when matching resourceId', () => {
    const ast = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/analytics/documents {
    match /events/{id} {
      allow list: if true;
    }
  }
}`)!;
    const matching = normalizeDatabaseRootAst(ast, 'analytics');
    expect(matching.service.match.path.segments[1]).toEqual({
      type: 'literal',
      value: '(default)',
    });

    const nonMatching = normalizeDatabaseRootAst(ast, 'other-db');
    expect(nonMatching.service.match.path.segments[1]).toEqual({
      type: 'literal',
      value: 'analytics',
    });
  });

  it('projects path-invariant collection-group list rules and drops path-dependent rules', () => {
    const validGroup = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isSignedIn() {
      return request.auth != null;
    }
    match /orgs/{orgId}/tasks/{taskId} {
      allow list: if true;
    }
    match /{path=**}/tasks/{taskId} {
      allow list: if isSignedIn() && resource.data.assigneeId == request.auth.uid;
    }
  }
}`)!;
    const projected = projectCollectionGroupAst(validGroup, 'tasks');
    expect(projected).not.toBeNull();
    expect(projected!.service.match.children.length).toBe(1);

    const pathDependent = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{path=**}/tasks/{taskId} {
      allow list: if request.auth.uid == taskId;
    }
  }
}`)!;
    expect(projectCollectionGroupAst(pathDependent, 'tasks')).toBeNull();
  });

  it('identifies unseeded lookup/claim dependencies, request.query reads, and optimistic field scalars', () => {
    const lookupAst = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/items/{id} {
      allow list: if exists(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid));
    }
  }
}`)!;
    const lookupInfo = inspectRetainedRules(lookupAst, 'orgs/o1/items/__listPlaceholder__', new Set());
    expect(lookupInfo.usesUnseededContext).toBe(true);
    expect(lookupInfo.usesRequestQuery).toBe(false);

    const queryAst = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /feed/{id} {
      allow list: if request.query.limit <= 25 && resource.data.status in ['open', 'pinned'];
    }
  }
}`)!;
    const queryInfo = inspectRetainedRules(queryAst, 'feed/__listPlaceholder__', new Set());
    expect(queryInfo.usesUnseededContext).toBe(false);
    expect(queryInfo.usesRequestQuery).toBe(true);
    expect(collectOptimisticFieldScalars(queryAst, 'feed/__listPlaceholder__', 'status')).toContain('open');
  });
});
