import { describe, expect, it } from 'bun:test';
import { aiLogicHeaders, tokenNeedsRemint } from '../../../src/capture/ai/request-headers.ts';
import { rig } from '../../../rigs/ai-logic.ts';

describe('ai-logic rig request headers', () => {
  it('sends the API key and the App Check token under the names @firebase/ai 2.12.0 uses', () => {
    const headers = aiLogicHeaders('key-value', 'token-value');
    expect(headers).toEqual({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'key-value',
      'X-Firebase-AppCheck': 'token-value',
    });
  });

  it('keeps the App Check token when the API key is overridden for the bad-key probe', () => {
    const headers = aiLogicHeaders('not-a-real-key', 'token-value');
    expect(headers['x-goog-api-key']).toBe('not-a-real-key');
    expect(headers['X-Firebase-AppCheck']).toBe('token-value');
  });
});

describe('App Check token remint', () => {
  const minted = 1_000_000;
  const hour = 60 * 60 * 1000;

  it('keeps a token with more than five minutes left', () => {
    expect(tokenNeedsRemint({ mintedAtMs: minted, ttlMillis: hour }, minted + 54 * 60 * 1000)).toBe(false);
  });

  it('mints again when five minutes or less are left', () => {
    expect(tokenNeedsRemint({ mintedAtMs: minted, ttlMillis: hour }, minted + 55 * 60 * 1000)).toBe(true);
    expect(tokenNeedsRemint({ mintedAtMs: minted, ttlMillis: hour }, minted + 2 * hour)).toBe(true);
  });
});

describe('ai-logic rig manifest', () => {
  it('requires the oracle service account to mint App Check tokens', () => {
    const serviceAccount = rig.requires.env.find((entry) => entry.name === 'PYRIC_ORACLE_SA_PATH');
    expect(serviceAccount).toBeDefined();
    expect(serviceAccount?.permission).toContain('firebaseappcheck.tokens.mint');
  });

  it('names the App Check API as a project feature', () => {
    expect(rig.requires.projectFeatures).toContain('Firebase App Check API enabled on the project.');
  });
});
