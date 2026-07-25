import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'RULES-AST-STRICT',
  rationale: 'Proves production Firebase Rules Test API rejects unsupported boolean casting, non-whitelisted math helpers, and bare map membership assertions.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /boolCast/{doc} {
      allow read: if bool('true') == true;
    }
    match /mathInfinite/{doc} {
      allow write: if math.isInfinite(1.0);
    }
    match /mapHasAll/{doc} {
      allow delete: if request.resource.data.hasAll(['required_key']);
      allow create: if request.resource.data.keys().hasAll(['required_key']);
    }
  }
}`,
  cases: [
    {
      description: 'bool() casting attempt DENIED due to function not found',
      expectation: 'DENY',
      method: 'get',
      path: 'boolCast/test1',
    },
    {
      description: 'math.isInfinite() invocation DENIED due to method not found',
      expectation: 'DENY',
      method: 'create',
      path: 'mathInfinite/test1',
      data: { value: 1.0 },
    },
    {
      description: 'bare map.hasAll() assertion DENIED without calling keys() first',
      expectation: 'DENY',
      method: 'delete',
      path: 'mapHasAll/test1',
      data: { required_key: 'present' },
    },
    {
      description: 'map.keys().hasAll() ALLOWED as standard CEL map membership syntax',
      expectation: 'ALLOW',
      method: 'create',
      path: 'mapHasAll/test1',
      data: { required_key: 'present' },
    },
  ],
  group: 'fix-class',
};
