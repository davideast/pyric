import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Item 7 (Batch Sibling Merge)',
  rationale: 'A single create whose rule reads two fields of another document through getAfter(), with a get mock that already holds both. Outside a batch getAfter() equals get(), so this case does not exercise a batch. A Firestore update applies a field mask: it keeps fields it does not name and replaces any nested map it names. The batch case for row firestore-rules#190 is the real-database probe in firestore-real-sibling-merge.ts.',
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
