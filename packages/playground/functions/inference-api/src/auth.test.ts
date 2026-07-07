/**
 * Tests for the public inference function auth + CORS gate (#766).
 */
import { describe, test, expect } from 'bun:test';
import {
  corsHeaders,
  evaluateRequest,
  headerLookup,
  loadAuthConfig,
  requestOrigin,
  type AuthConfig,
} from './auth';

const ALLOWED = 'https://pyric-playground.web.app';

function cfg(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    allowedOrigins: new Set([ALLOWED]),
    accessToken: '',
    ...overrides,
  };
}

describe('loadAuthConfig', () => {
  test('defaults include the playground hosting origins', () => {
    const c = loadAuthConfig({});
    expect(c.allowedOrigins.has('https://pyric-playground.web.app')).toBe(true);
    expect(c.accessToken).toBe('');
  });

  test('INFERENCE_ALLOWED_ORIGINS overrides defaults', () => {
    const c = loadAuthConfig({ INFERENCE_ALLOWED_ORIGINS: 'https://a.example, https://b.example/' });
    expect([...c.allowedOrigins]).toEqual(['https://a.example', 'https://b.example']);
  });
});

describe('requestOrigin', () => {
  test('reads Origin, falling back to Referer origin', () => {
    expect(requestOrigin(headerLookup({ origin: 'https://x.example/' }))).toBe('https://x.example');
    expect(requestOrigin(headerLookup({ referer: 'https://y.example/path?q=1' }))).toBe(
      'https://y.example',
    );
    expect(requestOrigin(headerLookup({}))).toBeUndefined();
  });
});

describe('evaluateRequest — origin gate', () => {
  test('rejects a POST with no Origin (unauthenticated non-browser call)', () => {
    const d = evaluateRequest('POST', headerLookup({}), cfg());
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(403);
    expect(d.reason).toBe('origin_not_allowed');
    expect(d.corsOrigin).toBeNull();
  });

  test('rejects a disallowed origin', () => {
    const d = evaluateRequest('POST', headerLookup({ origin: 'https://evil.example' }), cfg());
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(403);
  });

  test('allows an allowlisted origin when no token is required', () => {
    const d = evaluateRequest('POST', headerLookup({ origin: ALLOWED }), cfg());
    expect(d.allowed).toBe(true);
    expect(d.corsOrigin).toBe(ALLOWED);
  });
});

describe('evaluateRequest — token gate', () => {
  const withToken = cfg({ accessToken: 's3cret' });

  test('rejects an allowlisted origin without the token', () => {
    const d = evaluateRequest('POST', headerLookup({ origin: ALLOWED }), withToken);
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(401);
    expect(d.reason).toBe('missing_or_invalid_token');
  });

  test('rejects a wrong bearer token', () => {
    const d = evaluateRequest(
      'POST',
      headerLookup({ origin: ALLOWED, authorization: 'Bearer nope' }),
      withToken,
    );
    expect(d.status).toBe(401);
  });

  test('accepts a matching bearer token', () => {
    const d = evaluateRequest(
      'POST',
      headerLookup({ origin: ALLOWED, authorization: 'Bearer s3cret' }),
      withToken,
    );
    expect(d.allowed).toBe(true);
  });

  test('accepts a matching X-Firebase-AppCheck token', () => {
    const d = evaluateRequest(
      'POST',
      headerLookup({ origin: ALLOWED, 'x-firebase-appcheck': 's3cret' }),
      withToken,
    );
    expect(d.allowed).toBe(true);
  });
});

describe('CORS', () => {
  test('preflight from an allowed origin gets an origin-scoped grant (never *)', () => {
    const d = evaluateRequest('OPTIONS', headerLookup({ origin: ALLOWED }), cfg());
    expect(d.status).toBe(204);
    const h = corsHeaders(d);
    expect(h['Access-Control-Allow-Origin']).toBe(ALLOWED);
    expect(h['Access-Control-Allow-Origin']).not.toBe('*');
    expect(h['Access-Control-Allow-Headers']).toContain('Authorization');
    expect(h.Vary).toBe('Origin');
  });

  test('preflight from a disallowed origin gets no CORS grant', () => {
    const d = evaluateRequest('OPTIONS', headerLookup({ origin: 'https://evil.example' }), cfg());
    expect(corsHeaders(d)['Access-Control-Allow-Origin']).toBeUndefined();
  });
});
