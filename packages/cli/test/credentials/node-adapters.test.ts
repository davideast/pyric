import { describe, it, expect } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { fileCredentialStore } from '../../src/credentials/node/file-store.js';
import { loopbackAuthorizer } from '../../src/credentials/node/loopback-authorizer.js';
import type { StoredCredential } from '../../src/credentials/core/types.js';

const tmpPath = () => join(tmpdir(), `pyric-cred-${Math.random().toString(36).slice(2)}.json`);

describe('fileCredentialStore', () => {
  it('write -> read round-trips; clear removes', async () => {
    const store = fileCredentialStore(tmpPath());
    const cred: StoredCredential = { version: 1, refreshToken: 'RT', scopes: ['a', 'b'], clientId: 'c', obtainedAt: 1 };
    await store.write(cred);
    expect(await store.read()).toEqual(cred);
    await store.clear();
    expect(await store.read()).toBeNull();
  });
  it('missing file -> null', async () => {
    expect(await fileCredentialStore(tmpPath()).read()).toBeNull();
  });
  it('corrupt file -> null, never throws', async () => {
    const p = tmpPath();
    await writeFile(p, '{not json');
    expect(await fileCredentialStore(p).read()).toBeNull();
    await rm(p);
  });
  it('unknown shape -> null', async () => {
    const p = tmpPath();
    await writeFile(p, JSON.stringify({ version: 99 }));
    expect(await fileCredentialStore(p).read()).toBeNull();
    await rm(p);
  });
});

describe('loopbackAuthorizer', () => {
  const buildUrl = (r: string, state = 'ST') =>
    `https://accounts.google.com/auth?redirect_uri=${encodeURIComponent(r)}&state=${state}`;

  it('catches the code, validates state, returns the redirectUri', async () => {
    const authorizer = loopbackAuthorizer({
      print: () => {},
      openUrl: async (url) => {
        const u = new URL(url);
        await fetch(`${u.searchParams.get('redirect_uri')}/?code=TESTCODE&state=${u.searchParams.get('state')}`);
      },
    });
    const res = await authorizer.authorize({ buildUrl: (r) => buildUrl(r), state: 'ST' });
    expect(res.code).toBe('TESTCODE');
    expect(res.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('rejects on state mismatch (CSRF guard)', async () => {
    const authorizer = loopbackAuthorizer({
      print: () => {},
      openUrl: async (url) => {
        await fetch(`${new URL(url).searchParams.get('redirect_uri')}/?code=X&state=WRONG`);
      },
    });
    await expect(authorizer.authorize({ buildUrl: (r) => buildUrl(r), state: 'ST' })).rejects.toThrow('state mismatch');
  });

  it('times out when no redirect arrives', async () => {
    const authorizer = loopbackAuthorizer({ print: () => {}, openUrl: () => {}, timeoutMs: 60 });
    await expect(authorizer.authorize({ buildUrl: (r) => buildUrl(r), state: 'ST' })).rejects.toThrow('timed out');
  });
});
