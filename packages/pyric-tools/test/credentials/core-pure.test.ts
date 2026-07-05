import { describe, it, expect } from 'bun:test';
import { SCOPES, BASE_SCOPES, missingScope } from '../../src/credentials/core/scopes.js';
import { buildAuthUrl, pkce, randomState } from '../../src/credentials/core/authorize.js';
import { oauthClient } from '../../src/credentials/core/client.js';

const client = oauthClient({ clientId: 'test.apps.googleusercontent.com' });

describe('missingScope', () => {
  it('covered -> null; missing -> the scope', () => {
    expect(missingScope([SCOPES.firebase], SCOPES.firebase)).toBeNull();
    expect(missingScope([SCOPES.firebase], SCOPES.cloudPlatform)).toBe(SCOPES.cloudPlatform);
  });
  it('cloud-platform subsumes the narrow scopes', () => {
    expect(missingScope([SCOPES.cloudPlatform], SCOPES.firebase)).toBeNull();
    expect(missingScope([SCOPES.cloudPlatform], SCOPES.datastore)).toBeNull();
  });
});

describe('buildAuthUrl', () => {
  it('carries PKCE, scopes, offline access, and incremental consent', () => {
    const url = new URL(
      buildAuthUrl({ client, scopes: BASE_SCOPES, redirectUri: 'http://localhost:9099/cb', challenge: 'CHAL', state: 'ST' }),
    );
    const p = url.searchParams;
    expect(p.get('client_id')).toBe(client.clientId);
    expect(p.get('redirect_uri')).toBe('http://localhost:9099/cb');
    expect(p.get('code_challenge')).toBe('CHAL');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toBe('ST');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('include_granted_scopes')).toBe('true');
    expect(p.get('scope')).toContain('firebase');
  });
});

describe('pkce + randomState', () => {
  it('produce distinct base64url values', async () => {
    const a = await pkce();
    const b = await pkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomState()).not.toBe(randomState());
  });
});
