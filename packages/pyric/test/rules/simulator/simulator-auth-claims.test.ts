import { describe, test, expect } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';

const handler = new SimulateFirestoreRulesHandler();

const MULTI_TENANT_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tenants/{tenantId}/records/{id} {
      allow read: if request.auth != null
        && request.auth.tenant == 'tenant-xyz'
        && request.auth.token.firebase.tenant == 'tenant-xyz'
        && request.auth.token.email == 'alice@example.com'
        && request.auth.token.sub == 'user_123';
    }
  }
}`;

describe('01-firestore-simulator-tenant-and-token-claims', () => {
  test('SimulateFirestoreRulesHandler projects auth.tenant and standard token claims into request.auth', () => {
    const res = handler.simulate(MULTI_TENANT_RULES, [
      {
        description: 'tenant and token claims allow',
        expectation: 'ALLOW',
        method: 'get',
        path: 'tenants/tenant-xyz/records/rec1',
        auth: {
          uid: 'user_123',
          email: 'alice@example.com',
          tenant: 'tenant-xyz',
        } as any,
      },
    ]);

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.passed).toBe(1);
      expect(res.data.results[0].state).toBe('PASSED');
    }
  });
});
