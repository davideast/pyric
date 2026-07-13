import { describe, expect, it } from 'bun:test';
import type { App as AdminApp } from 'firebase-admin/app';

import { projectScopeFromAdminApp } from '../../../src/credentials/node/admin-app-scope.js';

function adminApp(options: {
  projectId?: string;
  credential?: { getAccessToken(): Promise<{ access_token: string; expires_in: number }> };
}): AdminApp {
  return { options } as unknown as AdminApp;
}

describe('projectScopeFromAdminApp', () => {
  it('resolves and memoizes the app credential token', async () => {
    let calls = 0;
    const scope = projectScopeFromAdminApp(
      adminApp({
        projectId: 'demo-project',
        credential: {
          async getAccessToken() {
            calls += 1;
            return { access_token: 'token', expires_in: 3600 };
          },
        },
      }),
    );

    expect(scope.projectId).toBe('demo-project');
    expect(await scope.resolveToken()).toBe('token');
    expect(await scope.resolveToken()).toBe('token');
    expect(calls).toBe(1);
  });

  it('requires a project id', () => {
    expect(() => projectScopeFromAdminApp(adminApp({}))).toThrow(
      'projectScopeFromAdminApp: firebase-admin App has no projectId',
    );
  });

  it('requires a credential token resolver', () => {
    expect(() => projectScopeFromAdminApp(adminApp({ projectId: 'demo-project' }))).toThrow(
      'projectScopeFromAdminApp: firebase-admin App was not initialized with a cert credential',
    );
  });
});
