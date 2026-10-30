/**
 * ─── atomic-batch-sibling-merge ──────────────────────────────────────────────
 * Targets Item 7: getAfter() during a multi-document batch. The hosted Rules
 * Test API cannot evaluate getAfter() (it reports "Function not found:
 * getAfter"), so run-rules.ts leaves this scenario to run-firestore-real.ts,
 * which captures the verdict through temporarily deployed rules and an
 * authenticated Web SDK batch against the real database.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Item 7 (Batch Sibling Merge)',
  rationale: 'Proves getAfter() evaluates against deep-merged sibling state during multi-document atomic updates.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /auditLogs/{logId} {
      allow create: if request.auth != null
                    && getAfter(/databases/$(database)/documents/config/state).data.role == 'admin'
                    && getAfter(/databases/$(database)/documents/config/state).data.modified == true;
    }
    match /config/{docId} {
      allow update: if request.auth != null;
    }
  }
}`,
  cases: [
    {
      description: 'getAfter reflects merged pre-existing fields alongside batch updates ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'auditLogs/log1',
      auth: { uid: 'verifier' },
      data: { action: 'update_config' },
      functionMocks: [
        { function: 'get', path: 'config/state', result: { role: 'admin', modified: true } },
      ],
    },
  ],
  group: 'fix-class',
};
