import { describe, test, expect } from 'bun:test';
import { InspectFirestoreRulesHandler } from '../../../src/rules/inspect/handler.js';
import type { ProjectScope } from '../../../src/project-scope.js';

const originalFetch = global.fetch;
function restoreFetch() { global.fetch = originalFetch; }

const MOCK_SCOPE: ProjectScope = {
  projectId: 'test-project',
  resolveToken: async () => 'mock-token',
};

const VALID_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAuthenticated() {
      return request.auth != null;
    }
    match /{document=**} {
      allow read, write: if false;
    }
    match /users/{userId} {
      allow read: if isAuthenticated();
      allow write: if request.auth.uid == userId;
    }
    match /posts/{postId} {
      allow read: if true;
      allow create: if request.auth != null;
      allow update: if resource.data.author == request.auth.uid;
      allow delete: if resource.data.author == request.auth.uid;
    }
  }
}`;

function mockRulesApi(rules: string = VALID_RULES) {
  let callCount = 0;
  (global as any).fetch = async (url: string) => {
    callCount++;
    if (callCount === 1) {
      // List rulesets
      return new Response(JSON.stringify({
        rulesets: [{
          name: 'projects/test-project/rulesets/abc-123',
          createTime: '2026-04-04T00:00:00Z',
          metadata: { services: ['cloud.firestore'] },
        }],
      }), { status: 200 });
    }
    // Get ruleset
    return new Response(JSON.stringify({
      name: 'projects/test-project/rulesets/abc-123',
      source: { files: [{ name: 'firestore.rules', content: rules }] },
      createTime: '2026-04-04T00:00:00Z',
    }), { status: 200 });
  };
}

describe('InspectFirestoreRulesHandler', () => {
  const handler = new InspectFirestoreRulesHandler();

  test('returns parsed rules with correct structure', async () => {
    mockRulesApi();
    try {
      const result = await handler.execute(MOCK_SCOPE);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.rules.version).toBe('2');
        expect(result.data.rules.service.name).toBe('cloud.firestore');
        expect(result.data.rulesetId).toBe('abc-123');
        expect(result.data.source).toBe(VALID_RULES);
      }
    } finally { restoreFetch(); }
  });

  test('summary includes match paths', async () => {
    mockRulesApi();
    try {
      const result = await handler.execute(MOCK_SCOPE);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.summary.matchPaths).toContain('/{document=**}');
        expect(result.data.summary.matchPaths).toContain('/users/{userId}');
        expect(result.data.summary.matchPaths).toContain('/posts/{postId}');
      }
    } finally { restoreFetch(); }
  });

  test('summary includes function names', async () => {
    mockRulesApi();
    try {
      const result = await handler.execute(MOCK_SCOPE);
      if (result.success) {
        expect(result.data.summary.functionNames).toContain('isAuthenticated');
      }
    } finally { restoreFetch(); }
  });

  test('summary counts operations', async () => {
    mockRulesApi();
    try {
      const result = await handler.execute(MOCK_SCOPE);
      if (result.success) {
        expect(result.data.summary.totalAllowRules).toBeGreaterThanOrEqual(5);
        expect(result.data.summary.operationCounts['read']).toBeGreaterThanOrEqual(2);
        expect(result.data.summary.operationCounts['write']).toBeGreaterThanOrEqual(1);
      }
    } finally { restoreFetch(); }
  });

  test('summary identifies public read paths', async () => {
    mockRulesApi();
    try {
      const result = await handler.execute(MOCK_SCOPE);
      if (result.success) {
        expect(result.data.summary.publicReadPaths).toContain('/posts/{postId}');
        expect(result.data.summary.publicReadPaths).not.toContain('/users/{userId}');
      }
    } finally { restoreFetch(); }
  });

  test('summary identifies public write paths', async () => {
    mockRulesApi();
    try {
      const result = await handler.execute(MOCK_SCOPE);
      if (result.success) {
        // No public write paths in the test rules
        expect(result.data.summary.publicWritePaths).toHaveLength(0);
      }
    } finally { restoreFetch(); }
  });

  test('handles API 403', async () => {
    (global as any).fetch = async () => new Response('', { status: 403 });
    try {
      const result = await handler.execute(MOCK_SCOPE);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('PERMISSION_DENIED');
    } finally { restoreFetch(); }
  });

  test('handles no rulesets', async () => {
    (global as any).fetch = async () => new Response(JSON.stringify({ rulesets: [] }), { status: 200 });
    try {
      const result = await handler.execute(MOCK_SCOPE);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NO_RULESETS');
    } finally { restoreFetch(); }
  });

  test('returns validation findings', async () => {
    mockRulesApi();
    try {
      const result = await handler.execute(MOCK_SCOPE);
      if (result.success) {
        expect(result.data.findings).toBeDefined();
        expect(Array.isArray(result.data.findings)).toBe(true);
        // The valid rules have no critical security issues
        const critical = result.data.findings.filter(f => f.severity === 'critical');
        expect(critical).toHaveLength(0);
      }
    } finally { restoreFetch(); }
  });

  test('insecure rules produce security findings', async () => {
    const insecure = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;
    mockRulesApi(insecure);
    try {
      const result = await handler.execute(MOCK_SCOPE);
      if (result.success) {
        expect(result.data.findings.some(f => f.code === 'SEC-1')).toBe(true);
        expect(result.data.findings.some(f => f.code === 'SEC-2')).toBe(true);
      }
    } finally { restoreFetch(); }
  });

  test('handles parse failure', async () => {
    mockRulesApi('this is not valid rules');
    try {
      const result = await handler.execute(MOCK_SCOPE);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('PARSE_FAILED');
    } finally { restoreFetch(); }
  });

  test('handles network error', async () => {
    (global as any).fetch = async () => { throw new Error('Network down'); };
    try {
      const result = await handler.execute(MOCK_SCOPE);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('Network down');
    } finally { restoreFetch(); }
  });
});
