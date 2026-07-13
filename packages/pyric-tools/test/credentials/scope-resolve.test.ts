import { afterEach, describe, expect, it } from 'bun:test';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveScope } from '../../src/cli/scope.js';
import { fromAdc } from '../../src/credentials/node/from-adc.js';
import type { ProjectScope } from '../../src/credentials/core/types.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockToken(body: unknown, status = 200): void {
  // @ts-expect-error override global for the test
  globalThis.fetch = async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

function env(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

function temporaryAdcPath(): string {
  return join(tmpdir(), `pyric-adc-${Math.random().toString(36).slice(2)}.json`);
}

describe('fromAdc', () => {
  it('turns an authorized_user credential into a refreshing project scope', async () => {
    const path = temporaryAdcPath();
    await writeFile(
      path,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'cid',
        client_secret: 'secret',
        refresh_token: 'refresh-token',
      }),
    );
    mockToken({ access_token: 'access-token', expires_in: 3600 });

    try {
      const scope = await fromAdc('project', env(), path);
      expect(scope?.projectId).toBe('project');
      expect(await scope?.resolveToken()).toBe('access-token');
    } finally {
      await rm(path, { force: true });
    }
  });

  it('returns null for a missing credential file', async () => {
    expect(await fromAdc('project', env(), temporaryAdcPath())).toBeNull();
  });

  it('applies the requested project to a service-account ADC credential', async () => {
    const path = temporaryAdcPath();
    await writeFile(
      path,
      JSON.stringify({
        type: 'service_account',
        client_email: 'sa@example.iam.gserviceaccount.com',
        private_key: 'private-key',
        project_id: 'credential-project',
      }),
    );

    try {
      const scope = await fromAdc('requested-project', env(), path);
      expect(scope?.projectId).toBe('requested-project');
    } finally {
      await rm(path, { force: true });
    }
  });

  it('returns null for an unsupported ADC credential type', async () => {
    const path = temporaryAdcPath();
    await writeFile(path, JSON.stringify({ type: 'external_account' }));

    try {
      expect(await fromAdc('project', env(), path)).toBeNull();
    } finally {
      await rm(path, { force: true });
    }
  });
});

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
