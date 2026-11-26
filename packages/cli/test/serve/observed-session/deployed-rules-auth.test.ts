import { describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTempDirs } from '../../use-temp-dirs.js';
import {
  CLI_TOKEN_REFRESH_MARGIN_MS,
  GOOGLE_OAUTH_TOKEN_URL,
  createDeveloperCliTokenProvider,
  developerAdcPath,
  type DeployedRulesAuthErrorCode,
  type DeployedRulesTokenResult,
} from '../../../src/serve/observed-session/deployed-rules-auth.js';

const makeTempDir = useTempDirs('pyric-deployed-auth-');

function writeFirebaseToolsConfig(rootDir: string, payload: unknown, useXdg = false): string {
  const dir = useXdg ? join(rootDir, 'configstore') : join(rootDir, '.config', 'configstore');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'firebase-tools.json');
  writeFileSync(filePath, JSON.stringify(payload), 'utf8');
  return filePath;
}

function writeAdcConfig(rootDir: string, payload: unknown, useCloudSdkDir = false): string {
  const dir = useCloudSdkDir ? rootDir : join(rootDir, '.config', 'gcloud');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'application_default_credentials.json');
  writeFileSync(filePath, JSON.stringify(payload), 'utf8');
  return filePath;
}

function snapshotTree(rootDir: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      entries.push(rel);
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      }
    }
  };
  walk(rootDir, '');
  return entries.sort();
}

describe('createDeveloperCliTokenProvider', () => {
  test('is strictly lazy: construction reads no files and makes no network calls', () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const dir = makeTempDir();
    createDeveloperCliTokenProvider({
      env: { HOME: dir },
      fetchImpl,
    });
    expect(fetchCalls).toBe(0);
    expect(snapshotTree(dir)).toEqual([]);
  });

  test('reads a fresh Firebase CLI token from firebase-tools.json without network or disk writes', async () => {
    const dir = makeTempDir();
    const nowMs = 1_700_000_000_000;
    writeFirebaseToolsConfig(dir, {
      tokens: {
        access_token: 'cli-secret-token-123',
        expires_at: nowMs + CLI_TOKEN_REFRESH_MARGIN_MS + 30_000,
      },
    });
    const beforeFiles = snapshotTree(dir);

    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      throw new Error('network should not be called');
    }) as typeof fetch;

    const provider = createDeveloperCliTokenProvider({
      env: { HOME: dir },
      now: () => nowMs,
      fetchImpl,
    });
    const first = await provider.resolveToken();
    const second = await provider.resolveToken();

    expect(first).toEqual({
      ok: true,
      source: 'firebase-cli',
      token: 'cli-secret-token-123',
      expiresAt: nowMs + CLI_TOKEN_REFRESH_MARGIN_MS + 30_000,
    });
    expect(second).toEqual(first);
    expect(fetchCalls).toBe(0);
    expect(snapshotTree(dir)).toEqual(beforeFiles);
  });

  test('honors XDG_CONFIG_HOME and falls back to multi-account users[email].tokens', async () => {
    const dir = makeTempDir();
    const xdgDir = join(dir, 'xdg');
    const nowMs = 1_700_000_000_000;
    writeFirebaseToolsConfig(
      xdgDir,
      {
        user: { email: 'dev@example.com' },
        users: {
          'dev@example.com': {
            tokens: {
              access_token: 'multi-account-token',
              expires_at: nowMs + 600_000,
            },
          },
        },
      },
      true,
    );

    const provider = createDeveloperCliTokenProvider({
      env: { HOME: dir, XDG_CONFIG_HOME: xdgDir },
      now: () => nowMs,
    });
    const result = await provider.resolveToken();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('firebase-cli');
      expect(result.token).toBe('multi-account-token');
    }
  });

  test('reports token-expired when Firebase CLI token is stale and no ADC login exists, without leaking token', async () => {
    const dir = makeTempDir();
    const nowMs = 1_700_000_000_000;
    const expiredSecret = 'expired-super-secret-token';
    writeFirebaseToolsConfig(dir, {
      tokens: {
        access_token: expiredSecret,
        expires_at: nowMs + 10_000,
      },
    });

    const provider = createDeveloperCliTokenProvider({
      env: { HOME: dir },
      now: () => nowMs,
    });
    const result = await provider.resolveToken();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('token-expired');
      expect(result.message).toContain('firebase login');
      expect(JSON.stringify(result)).not.toContain(expiredSecret);
    }
  });

  test('rejects tokens containing CR/LF control characters to prevent header injection', async () => {
    const dir = makeTempDir();
    const nowMs = 1_700_000_000_000;
    writeFirebaseToolsConfig(dir, {
      tokens: {
        access_token: 'good-part\r\nX-Injected: evil',
        expires_at: nowMs + 600_000,
      },
    });

    const provider = createDeveloperCliTokenProvider({
      env: { HOME: dir },
      now: () => nowMs,
    });
    const result = await provider.resolveToken();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unauthenticated');
      expect(JSON.stringify(result)).not.toContain('X-Injected');
    }
  });

  test('falls back from expired Firebase CLI token to ADC authorized_user via hardcoded OAuth endpoint with redirect manual', async () => {
    const dir = makeTempDir();
    const gcloudDir = join(dir, 'gcloud-cfg');
    let nowMs = 1_700_000_000_000;
    writeFirebaseToolsConfig(dir, {
      tokens: {
        access_token: 'stale-cli-token',
        expires_at: nowMs - 1_000,
      },
    });
    writeAdcConfig(
      gcloudDir,
      {
        type: 'authorized_user',
        client_id: 'adc-client-id',
        client_secret: 'adc-client-secret-xyz',
        refresh_token: 'adc-refresh-secret-abc',
      },
      true,
    );
    const beforeFiles = snapshotTree(dir);

    const calls: Array<{ url: string; method: string | undefined; redirect: RequestRedirect | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, redirect: init?.redirect });
      return new Response(
        JSON.stringify({ access_token: 'fresh-adc-token-1', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const provider = createDeveloperCliTokenProvider({
      env: { HOME: dir, CLOUDSDK_CONFIG: gcloudDir },
      now: () => nowMs,
      fetchImpl,
    });
    expect(developerAdcPath({ HOME: dir, CLOUDSDK_CONFIG: gcloudDir })).toBe(
      join(gcloudDir, 'application_default_credentials.json'),
    );

    const [a, b] = await Promise.all([provider.resolveToken(), provider.resolveToken()]);
    expect(a.ok).toBe(true);
    expect(b).toEqual(a);
    if (a.ok) {
      expect(a.source).toBe('adc');
      expect(a.token).toBe('fresh-adc-token-1');
    }
    expect(calls).toEqual([{ url: GOOGLE_OAUTH_TOKEN_URL, method: 'POST', redirect: 'manual' }]);
    expect(snapshotTree(dir)).toEqual(beforeFiles);

    // Advance past expiry margin to verify in-memory refresh.
    nowMs += 3_600_000;
    const refreshed = await provider.resolveToken();
    expect(refreshed.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test('blocks redirects and never leaks ADC secrets or raw error body on failed token exchange', async () => {
    const dir = makeTempDir();
    writeAdcConfig(dir, {
      type: 'authorized_user',
      client_id: 'cid-1',
      client_secret: 'super-secret-client-secret',
      refresh_token: 'super-secret-refresh-token',
    });

    const redirectFetch = (async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })) as typeof fetch;
    const redirectProvider = createDeveloperCliTokenProvider({
      env: { HOME: dir },
      fetchImpl: redirectFetch,
    });
    const redirectRes = await redirectProvider.resolveToken();
    expect(redirectRes.ok).toBe(false);
    if (!redirectRes.ok) {
      expect(redirectRes.code).toBe('redirect-blocked');
      const serialized = JSON.stringify(redirectRes);
      expect(serialized).not.toContain('super-secret-client-secret');
      expect(serialized).not.toContain('super-secret-refresh-token');
      expect(serialized).not.toContain('evil.example');
    }

    const errorFetch = (async () =>
      new Response('error echoing super-secret-refresh-token and raw debug detail', { status: 400 })) as typeof fetch;
    const errorProvider = createDeveloperCliTokenProvider({
      env: { HOME: dir },
      fetchImpl: errorFetch,
    });
    const errorRes = await errorProvider.resolveToken();
    expect(errorRes.ok).toBe(false);
    if (!errorRes.ok) {
      expect(errorRes.code).toBe('token-exchange-failed');
      expect(errorRes.message).toContain('HTTP 400');
      const serialized = JSON.stringify(errorRes);
      expect(serialized).not.toContain('super-secret-refresh-token');
      expect(serialized).not.toContain('super-secret-client-secret');
      expect(serialized).not.toContain('raw debug detail');
    }
  });

  test('returns unauthenticated cleanly when neither firebase-tools nor ADC files exist', async () => {
    const dir = makeTempDir();
    const provider = createDeveloperCliTokenProvider({ env: { HOME: dir } });
    const result: DeployedRulesTokenResult = await provider.resolveToken();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const code: DeployedRulesAuthErrorCode = result.code;
      expect(code).toBe('unauthenticated');
      expect(result.message).toContain('firebase login');
    }
  });

  test('skips oversized credential files (> 256 KiB) and rejects oversized OAuth responses (> 64 KiB)', async () => {
    const dir = makeTempDir();
    const nowMs = 1_700_000_000_000;
    writeFirebaseToolsConfig(dir, {
      tokens: { access_token: 'valid-but-too-large-file', expires_at: nowMs + 600_000 },
      padding: 'x'.repeat(300 * 1024),
    });
    const oversizedFileProvider = createDeveloperCliTokenProvider({
      env: { HOME: dir },
      now: () => nowMs,
    });
    const fileRes = await oversizedFileProvider.resolveToken();
    expect(fileRes.ok).toBe(false);
    if (!fileRes.ok) {
      expect(fileRes.code).toBe('unauthenticated');
    }

    const adcDir = makeTempDir();
    writeAdcConfig(adcDir, {
      type: 'authorized_user',
      client_id: 'cid-1',
      client_secret: 'secret-1',
      refresh_token: 'refresh-1',
    });
    const hugeOauthFetch = (async () =>
      new Response(JSON.stringify({ access_token: 'tok', pad: 'y'.repeat(80 * 1024) }), {
        status: 200,
      })) as typeof fetch;
    const adcProvider = createDeveloperCliTokenProvider({
      env: { HOME: adcDir },
      now: () => nowMs,
      fetchImpl: hugeOauthFetch,
    });
    const adcRes = await adcProvider.resolveToken();
    expect(adcRes.ok).toBe(false);
    if (!adcRes.ok) {
      expect(adcRes.code).toBe('token-exchange-failed');
    }
  });
});
