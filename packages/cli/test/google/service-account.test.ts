/**
 * `fromServiceAccount` tests — the security-critical primitive
 * that handles SA private keys, signs JWTs, and exchanges them for
 * OAuth tokens. Network calls are stubbed via `fetch` mocks.
 *
 * Key vectors used here are throwaway test keys (NEVER real
 * service accounts). Generated once with `openssl genrsa 2048` and
 * checked in — they sign + verify in tests without touching
 * production secrets.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromServiceAccount } from '../../src/google/service-account.js';

const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = originalFetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

interface FetchCall { url: string; init: RequestInit | undefined }

function installFetchMock(responses: Response[]): { calls: FetchCall[] } {
  const queue = [...responses];
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`Fetch mock ran out of queued responses (called ${url})`);
    return Promise.resolve(next);
  }) as typeof fetch;
  return { calls };
}

function tokenResponse(access_token: string, expires_in = 3600): Response {
  return new Response(
    JSON.stringify({ access_token, expires_in, token_type: 'Bearer' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Build a fake SA with a fresh RSA keypair for each test that needs one. */
function fakeSa(projectId = 'test-project'): {
  sa: {
    client_email: string;
    private_key: string;
    project_id: string;
    token_uri?: string;
  };
  publicKey: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    sa: {
      client_email: `test@${projectId}.iam.gserviceaccount.com`,
      private_key: privateKey,
      project_id: projectId,
    },
    publicKey,
  };
}

describe('fromServiceAccount — input shapes', () => {
  it('accepts inline JSON', async () => {
    const { sa } = fakeSa();
    installFetchMock([tokenResponse('TKN-1')]);
    const scope = await fromServiceAccount(JSON.stringify(sa));
    expect(scope.projectId).toBe(sa.project_id);
    expect(await scope.resolveToken()).toBe('TKN-1');
  });

  it('accepts a `base64:` prefixed encoded SA', async () => {
    const { sa } = fakeSa();
    const b64 = Buffer.from(JSON.stringify(sa), 'utf-8').toString('base64');
    installFetchMock([tokenResponse('TKN-base64')]);
    const scope = await fromServiceAccount(`base64:${b64}`);
    expect(await scope.resolveToken()).toBe('TKN-base64');
  });

  it('accepts a filesystem path', async () => {
    const { sa } = fakeSa();
    const dir = await mkdtemp(join(tmpdir(), 'sa-test-'));
    try {
      const path = join(dir, 'sa.json');
      await writeFile(path, JSON.stringify(sa), 'utf-8');
      installFetchMock([tokenResponse('TKN-file')]);
      const scope = await fromServiceAccount(path);
      expect(await scope.resolveToken()).toBe('TKN-file');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects SA JSON missing required fields with an actionable message', async () => {
    await expect(fromServiceAccount('{"client_email":"x@y"}')).rejects.toThrow(
      /missing required fields/,
    );
  });

  it('rejects malformed JSON early', async () => {
    await expect(fromServiceAccount('{not json}')).rejects.toThrow();
  });
});

describe('fromServiceAccount — JWT signing', () => {
  it('signs a JWT that verifies against the SA public key', async () => {
    const { sa, publicKey } = fakeSa();
    const { calls } = installFetchMock([tokenResponse('TKN')]);
    const scope = await fromServiceAccount(JSON.stringify(sa));
    await scope.resolveToken();

    const body = new URLSearchParams(calls[0].init!.body as string);
    const jwt = body.get('assertion')!;
    const [headerB64, claimsB64, signatureB64] = jwt.split('.');

    // Verify RSA-SHA256 signature against the public key.
    const signingInput = `${headerB64}.${claimsB64}`;
    const signature = Buffer.from(signatureB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingInput);
    verifier.end();
    const valid = verifier.verify(createPublicKey(publicKey), signature);
    expect(valid).toBe(true);
  });

  it('JWT carries iss + aud + scope claims with the right values', async () => {
    const { sa } = fakeSa('my-proj');
    const { calls } = installFetchMock([tokenResponse('TKN')]);
    const scope = await fromServiceAccount(JSON.stringify(sa));
    await scope.resolveToken();

    const body = new URLSearchParams(calls[0].init!.body as string);
    const jwt = body.get('assertion')!;
    const [, claimsB64] = jwt.split('.');
    const claims = JSON.parse(
      Buffer.from(claimsB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'),
    );

    expect(claims.iss).toBe(sa.client_email);
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(claims.scope).toBe('https://www.googleapis.com/auth/cloud-platform');
    expect(claims.scope).toContain('cloud-platform');
    expect(claims.exp - claims.iat).toBe(3600);
  });
});

describe('fromServiceAccount — token exchange', () => {
  it('POSTs to the Google token endpoint with grant_type + assertion', async () => {
    const { sa } = fakeSa();
    const { calls } = installFetchMock([tokenResponse('TKN-x')]);
    const scope = await fromServiceAccount(JSON.stringify(sa));
    await scope.resolveToken();

    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const body = new URLSearchParams(calls[0].init!.body as string);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(body.get('assertion')).toBeTruthy();
  });

  it('memoizes the token across resolveToken calls (90% TTL)', async () => {
    const { sa } = fakeSa();
    const { calls } = installFetchMock([tokenResponse('TKN-once', 100)]);
    const scope = await fromServiceAccount(JSON.stringify(sa));
    expect(await scope.resolveToken()).toBe('TKN-once');
    expect(await scope.resolveToken()).toBe('TKN-once');
    expect(await scope.resolveToken()).toBe('TKN-once');
    // Only one fetch call — second + third resolves hit the cache.
    expect(calls.length).toBe(1);
  });

  it('throws when the token endpoint returns a non-2xx', async () => {
    const { sa } = fakeSa();
    installFetchMock([new Response('forbidden', { status: 403 })]);
    const scope = await fromServiceAccount(JSON.stringify(sa));
    await expect(scope.resolveToken()).rejects.toThrow(/token exchange failed.*403/);
  });

  it('honors the SA-supplied token_uri override', async () => {
    const { sa } = fakeSa();
    const customSa = { ...sa, token_uri: 'https://custom.example.com/token' };
    const { calls } = installFetchMock([tokenResponse('TKN-custom')]);
    const scope = await fromServiceAccount(JSON.stringify(customSa));
    await scope.resolveToken();
    expect(calls[0].url).toBe('https://custom.example.com/token');
  });
});
