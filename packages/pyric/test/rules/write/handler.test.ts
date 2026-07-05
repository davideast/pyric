import { describe, test, expect } from 'bun:test';
import { WriteFirestoreRulesHandler } from '../../../src/rules/write/handler.js';
import type { ProjectScope } from 'pyric-tools/deploy';

const MOCK_SCOPE: ProjectScope = {
  projectId: 'test-project',
  resolveToken: async () => 'mock-token',
};

const VALID_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
    match /users/{userId} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == userId;
    }
  }
}`;

const INSECURE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

const INVALID_SYNTAX = 'this is not valid firestore rules';

const originalFetch = global.fetch;
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function mockFetch(responses: Array<{ status: number; body?: unknown }>) {
  let callIdx = 0;
  fetchCalls = [];
  (global as any).fetch = async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    const resp = responses[callIdx] ?? { status: 500 };
    callIdx++;
    return new Response(JSON.stringify(resp.body ?? {}), { status: resp.status });
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
  fetchCalls = [];
}

describe('WriteFirestoreRulesHandler', () => {
  const handler = new WriteFirestoreRulesHandler();

  // ---- Increment 1: Validation gate ----

  describe('validation gate', () => {
    test('PARSE_FAILED on invalid syntax', async () => {
      const result = await handler.execute(MOCK_SCOPE, INVALID_SYNTAX);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PARSE_FAILED');
        expect(result.error.recoverable).toBe(true);
      }
    });

    test('PARSE_FAILED on empty source', async () => {
      const result = await handler.execute(MOCK_SCOPE, '');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PARSE_FAILED');
        expect(result.error.recoverable).toBe(true);
      }
    });

    test('PARSE_FAILED on rules_version 1', async () => {
      const v1Rules = `rules_version = '1';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{doc=**} { allow read, write: if false; }
  }
}`;
      const result = await handler.execute(MOCK_SCOPE, v1Rules);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PARSE_FAILED');
        expect(result.error.message).toContain("'1'");
      }
    });

    test('CRITICAL_FINDINGS on insecure rules', async () => {
      const result = await handler.execute(MOCK_SCOPE, INSECURE_RULES);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('CRITICAL_FINDINGS');
        expect(result.error.recoverable).toBe(true);
        expect(result.error.findings).toBeDefined();
        expect(result.error.findings!.some(f => f.severity === 'critical')).toBe(true);
      }
    });

    test('CRITICAL_FINDINGS includes all findings not just critical', async () => {
      const result = await handler.execute(MOCK_SCOPE, INSECURE_RULES);
      if (!result.success && result.error.findings) {
        // Insecure rules produce both critical (SEC-1) and non-critical findings
        const severities = new Set(result.error.findings.map(f => f.severity));
        expect(severities.size).toBeGreaterThan(1);
      }
    });

    test('valid rules with no critical findings proceed to deploy', async () => {
      mockFetch([
        { status: 200, body: { name: 'projects/test-project/rulesets/abc-123' } },
        { status: 200, body: { name: 'projects/test-project/releases/cloud.firestore' } },
      ]);
      try {
        const result = await handler.execute(MOCK_SCOPE, VALID_RULES);
        expect(result.success).toBe(true);
      } finally { restoreFetch(); }
    });

    test('non-critical findings do not block deploy', async () => {
      // Rules with public read (QUA-1 low) but no critical findings
      const rulesWithPublicRead = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
    match /posts/{postId} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}`;
      mockFetch([
        { status: 200, body: { name: 'projects/test-project/rulesets/abc-123' } },
        { status: 200, body: { name: 'projects/test-project/releases/cloud.firestore' } },
      ]);
      try {
        const result = await handler.execute(MOCK_SCOPE, rulesWithPublicRead);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.findings.length).toBeGreaterThan(0);
        }
      } finally { restoreFetch(); }
    });
  });

  // ---- Increment 2: API calls ----

  describe('API calls', () => {
    test('success: creates ruleset then release, returns rulesetId', async () => {
      mockFetch([
        { status: 200, body: { name: 'projects/test-project/rulesets/new-id-456' } },
        { status: 200, body: { name: 'projects/test-project/releases/cloud.firestore' } },
      ]);
      try {
        const result = await handler.execute(MOCK_SCOPE, VALID_RULES);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.rulesetId).toBe('new-id-456');
        }
      } finally { restoreFetch(); }
    });

    test('POST to /rulesets with source in body', async () => {
      mockFetch([
        { status: 200, body: { name: 'projects/test-project/rulesets/abc' } },
        { status: 200, body: {} },
      ]);
      try {
        await handler.execute(MOCK_SCOPE, VALID_RULES);
        expect(fetchCalls[0].url).toContain('/projects/test-project/rulesets');
        expect(fetchCalls[0].init?.method).toBe('POST');
        const body = JSON.parse(fetchCalls[0].init?.body as string);
        expect(body.source.files[0].name).toBe('firestore.rules');
        expect(body.source.files[0].content).toBe(VALID_RULES);
      } finally { restoreFetch(); }
    });

    test('PATCH to /releases/cloud.firestore with rulesetName AND release.name', async () => {
      // Regression guard: the API silently ignores the PATCH (200 OK but no
      // active-release update) when `release.name` is missing from the body.
      // The URL path-param is not enough — the body field is authoritative.
      mockFetch([
        { status: 200, body: { name: 'projects/test-project/rulesets/abc' } },
        { status: 200, body: {} },
      ]);
      try {
        await handler.execute(MOCK_SCOPE, VALID_RULES);
        expect(fetchCalls[1].url).toContain('/releases/cloud.firestore');
        expect(fetchCalls[1].init?.method).toBe('PATCH');
        const body = JSON.parse(fetchCalls[1].init?.body as string);
        expect(body.release.rulesetName).toBe('projects/test-project/rulesets/abc');
        expect(body.release.name).toBe('projects/test-project/releases/cloud.firestore');
      } finally { restoreFetch(); }
    });

    test('auth header includes Bearer token', async () => {
      mockFetch([
        { status: 200, body: { name: 'projects/test-project/rulesets/abc' } },
        { status: 200, body: {} },
      ]);
      try {
        await handler.execute(MOCK_SCOPE, VALID_RULES);
        const headers = fetchCalls[0].init?.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer mock-token');
      } finally { restoreFetch(); }
    });

    test('403 on create ruleset → PERMISSION_DENIED', async () => {
      mockFetch([{ status: 403 }]);
      try {
        const result = await handler.execute(MOCK_SCOPE, VALID_RULES);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe('PERMISSION_DENIED');
          expect(result.error.recoverable).toBe(false);
        }
      } finally { restoreFetch(); }
    });

    test('400 on create ruleset → CREATE_RULESET_FAILED (recoverable)', async () => {
      mockFetch([{ status: 400, body: { error: { message: 'Invalid rules' } } }]);
      try {
        const result = await handler.execute(MOCK_SCOPE, VALID_RULES);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe('CREATE_RULESET_FAILED');
          expect(result.error.recoverable).toBe(true);
        }
      } finally { restoreFetch(); }
    });

    test('403 on create release → PERMISSION_DENIED', async () => {
      mockFetch([
        { status: 200, body: { name: 'projects/test-project/rulesets/abc' } },
        { status: 403 },
      ]);
      try {
        const result = await handler.execute(MOCK_SCOPE, VALID_RULES);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe('PERMISSION_DENIED');
        }
      } finally { restoreFetch(); }
    });

    test('network error → DEPLOY_FAILED', async () => {
      (global as any).fetch = async () => { throw new Error('Network down'); };
      try {
        const result = await handler.execute(MOCK_SCOPE, VALID_RULES);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe('DEPLOY_FAILED');
          expect(result.error.message).toContain('Network down');
        }
      } finally { restoreFetch(); }
    });

    test('malformed JSON from create ruleset → DEPLOY_FAILED', async () => {
      fetchCalls = [];
      (global as any).fetch = async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init });
        return new Response('not json{{{', { status: 200 });
      };
      try {
        const result = await handler.execute(MOCK_SCOPE, VALID_RULES);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe('DEPLOY_FAILED');
        }
      } finally { restoreFetch(); }
    });

    test('release not called if ruleset fails', async () => {
      mockFetch([{ status: 400, body: { error: 'bad' } }]);
      try {
        await handler.execute(MOCK_SCOPE, VALID_RULES);
        expect(fetchCalls.length).toBe(1);
      } finally { restoreFetch(); }
    });

    test('source sent to API unmodified', async () => {
      const sourceWithTrailing = VALID_RULES + '\n\n// trailing\n';
      mockFetch([
        { status: 200, body: { name: 'projects/test-project/rulesets/abc' } },
        { status: 200, body: {} },
      ]);
      try {
        await handler.execute(MOCK_SCOPE, sourceWithTrailing);
        const body = JSON.parse(fetchCalls[0].init?.body as string);
        expect(body.source.files[0].content).toBe(sourceWithTrailing);
      } finally { restoreFetch(); }
    });
  });

  // ---- Bug bash: additional edge cases ----

  describe('edge cases from bug bash', () => {
    test('whitespace-only source → PARSE_FAILED', async () => {
      const result = await handler.execute(MOCK_SCOPE, '   \n\t  ');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('PARSE_FAILED');
    });

    test('SEC-3 high finding does not block deploy', async () => {
      const rulesWithHighFinding = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
    match /items/{id} {
      allow read: if request.auth != null;
      allow write: if resource.data.owner == request.auth.uid;
    }
  }
}`;
      mockFetch([
        { status: 200, body: { name: 'projects/test-project/rulesets/abc' } },
        { status: 200, body: {} },
      ]);
      try {
        const result = await handler.execute(MOCK_SCOPE, rulesWithHighFinding);
        expect(result.success).toBe(true);
      } finally { restoreFetch(); }
    });

    test('deny-all rules deploy with no critical findings', async () => {
      const denyAll = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`;
      mockFetch([
        { status: 200, body: { name: 'projects/test-project/rulesets/abc' } },
        { status: 200, body: {} },
      ]);
      try {
        const result = await handler.execute(MOCK_SCOPE, denyAll);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.findings.filter(f => f.severity === 'critical')).toHaveLength(0);
        }
      } finally { restoreFetch(); }
    });

    test('PARSE_FAILED error has no findings field', async () => {
      const result = await handler.execute(MOCK_SCOPE, 'garbage');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PARSE_FAILED');
        expect(result.error.findings).toBeUndefined();
      }
    });

    test('PARSE_FAILED error includes structured parseError with line/col/expected', async () => {
      const broken = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /x/{id} { allow read: if (true; }
  }
}`;
      const result = await handler.execute(MOCK_SCOPE, broken);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PARSE_FAILED');
        expect(result.error.parseError).toBeDefined();
        expect(result.error.parseError!.line).toBeGreaterThan(0);
        expect(result.error.parseError!.column).toBeGreaterThan(0);
        expect(result.error.parseError!.expected).toContain(')');
        // The human-readable message also embeds the structured info.
        expect(result.error.message).toContain('line');
        expect(result.error.message).toContain('col');
      }
    });

    test('409 on create ruleset → CREATE_RULESET_FAILED', async () => {
      mockFetch([{ status: 409, body: { error: 'Conflict' } }]);
      try {
        const result = await handler.execute(MOCK_SCOPE, VALID_RULES);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe('CREATE_RULESET_FAILED');
        }
      } finally { restoreFetch(); }
    });

    test('500 on create release → CREATE_RELEASE_FAILED', async () => {
      mockFetch([
        { status: 200, body: { name: 'projects/test-project/rulesets/abc' } },
        { status: 500, body: { error: 'Server Error' } },
      ]);
      try {
        const result = await handler.execute(MOCK_SCOPE, VALID_RULES);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe('CREATE_RELEASE_FAILED');
        }
      } finally { restoreFetch(); }
    });
  });
});
