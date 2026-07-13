import { afterEach, describe, expect, it } from 'bun:test';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fromAdc } from '../../../src/credentials/node/from-adc.js';

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

  it('uses the authorized_user fields for the refresh-token exchange', async () => {
    const path = temporaryAdcPath();
    await writeFile(
      path,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'adc-client',
        client_secret: 'adc-secret',
        refresh_token: 'adc-refresh-token',
      }),
    );
    let request: Request | undefined;
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }));
    };

    try {
      const scope = await fromAdc('project', env(), path);
      await scope?.resolveToken();
      expect(request?.url).toBe('https://oauth2.googleapis.com/token');
      expect(await request?.text()).toBe(
        'client_id=adc-client&client_secret=adc-secret&refresh_token=adc-refresh-token&grant_type=refresh_token',
      );
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
