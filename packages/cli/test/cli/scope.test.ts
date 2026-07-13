import { describe, expect, it } from 'bun:test';

import { resolveScope } from '../../src/cli/scope.js';
import type { ProjectScope } from '../../src/credentials/core/types.js';

function env(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe('resolveScope', () => {
  it('prefers a service-account environment credential', async () => {
    const serviceAccount = Buffer.from(
      JSON.stringify({
        client_email: 'sa@example.iam.gserviceaccount.com',
        private_key: 'private-key',
        project_id: 'service-account-project',
      }),
    ).toString('base64');

    const resolved = await resolveScope({
      env: env({ FIREBASE_SA_BASE64: serviceAccount }),
    });

    expect(resolved.source).toBe('FIREBASE_SA_BASE64');
    expect(resolved.scope.projectId).toBe('service-account-project');
  });

  it('uses ADC as the final credential source', async () => {
    const adcScope: ProjectScope = {
      projectId: 'project',
      resolveToken: async () => 'adc-token',
    };
    const resolved = await resolveScope({
      env: env(),
      projectId: 'project',
      adc: async () => adcScope,
    });

    expect(resolved.source).toBe('adc');
    expect(resolved.scope).toBe(adcScope);
  });

  it('reports the supported Rules Test API credential sources when none resolve', async () => {
    await expect(
      resolveScope({
        env: env(),
        projectId: 'project',
        adc: async () => null,
      }),
    ).rejects.toThrow('Rules Test API verification requires');
  });

  it('does not accept a Pyric refresh token as a Rules Test API credential', async () => {
    await expect(
      resolveScope({
        env: env({ PYRIC_REFRESH_TOKEN: 'removed-token-source' }),
        projectId: 'project',
        adc: async () => null,
      }),
    ).rejects.toThrow('Rules Test API verification requires');
  });
});
