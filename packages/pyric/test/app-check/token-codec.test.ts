/**
 * The shared sandbox App Check token codec (`pyric/sandbox/internal`).
 *
 * Decoding matches encoding: the payload is UTF-8, as firebase-admin's jws
 * decode reads it (`Buffer.from(payload, 'base64').toString('utf8')`). The
 * codec uses `atob`/`btoa` and `TextEncoder`/`TextDecoder` only, so it runs the
 * same in a browser or worker; the parity case deletes Node's `Buffer` to prove
 * nothing falls back to it (AGENTS.md item 5).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { checkAppCheckToken, mintAppCheckToken, signAppCheckToken } from '../../src/sandbox/internal/index.js';

const APP_ID = '1:123456789012:web:0a1b2c3d4e5f60718293a4';
const HEADER = { alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' };
const savedBuffer = (globalThis as { Buffer?: unknown }).Buffer;

afterEach(() => {
  (globalThis as { Buffer?: unknown }).Buffer = savedBuffer;
});

/** Each case: claims to sign, chosen so the payload's base64 length lands on every padding remainder. */
const CLAIM_CASES: Record<string, Record<string, unknown>> = {
  ascii: { sub: APP_ID, aud: ['projects/p'], iss: 'https://firebaseappcheck.googleapis.com/1', exp: 1, iat: 0, jti: 'a' },
  latin: { sub: APP_ID, aud: ['projects/prøject'], iss: 'https://firebaseappcheck.googleapis.com/1', exp: 1, iat: 0, jti: 'ab' },
  cjk: { sub: APP_ID, aud: ['projects/日本'], iss: 'https://firebaseappcheck.googleapis.com/1', exp: 1, iat: 0, jti: 'abc' },
  emoji: { sub: APP_ID, aud: ['projects/x'], note: 'café 🔥', exp: 1, iat: 0, jti: 'abcd' },
  empty: {},
};

async function decodeEach(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [name, claims] of Object.entries(CLAIM_CASES)) {
    const check = await checkAppCheckToken(await signAppCheckToken(HEADER, claims));
    out[name] = check.ok ? { header: check.header, claims: check.claims } : check;
  }
  return out;
}

describe('sandbox App Check token codec', () => {
  it('decodes the UTF-8 payload it encodes', async () => {
    for (const [name, claims] of Object.entries(CLAIM_CASES)) {
      const check = await checkAppCheckToken(await signAppCheckToken(HEADER, claims));
      expect({ name, ok: check.ok }).toEqual({ name, ok: true });
      if (check.ok) expect(check.claims).toEqual(claims as never);
    }
  });

  it('round-trips a minted token whose project id is not ASCII', async () => {
    const minted = await mintAppCheckToken({ appId: APP_ID, projectId: 'prøject-日本' }, 3600);
    const check = await checkAppCheckToken(minted.token);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.claims.aud).toEqual(['projects/123456789012', 'projects/prøject-日本']);
  });

  it('decodes the same without the Node Buffer global', async () => {
    const withBuffer = await decodeEach();
    delete (globalThis as { Buffer?: unknown }).Buffer;
    expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe('undefined');
    const withoutBuffer = await decodeEach();
    expect(withoutBuffer).toEqual(withBuffer);
  });

  it('returns the decoded header with the claims', async () => {
    const check = await checkAppCheckToken(await signAppCheckToken({ alg: 'RS256', typ: 'JWT' }, CLAIM_CASES.ascii!));
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.header).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('reports a kid that names no sandbox key before checking the signature', async () => {
    const token = await signAppCheckToken({ ...HEADER, kid: 'someone-elses-key' }, CLAIM_CASES.ascii!);
    const check = await checkAppCheckToken(token);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('kid');
  });

  it('checks a token with no kid against the sandbox key, as firebase-admin tries every key', async () => {
    const signed = await checkAppCheckToken(await signAppCheckToken({ alg: 'RS256', typ: 'JWT' }, CLAIM_CASES.ascii!));
    expect(signed.ok).toBe(true);
    const [header, payload] = (await signAppCheckToken({ alg: 'RS256', typ: 'JWT' }, CLAIM_CASES.ascii!)).split('.');
    const tampered = await checkAppCheckToken(`${header}.${payload}.AAAA`);
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.reason).toBe('signature');
  });
});
