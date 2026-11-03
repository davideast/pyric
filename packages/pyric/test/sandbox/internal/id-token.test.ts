/**
 * Sandbox ID tokens (#1836) on the shared signer (`sandbox-jwt.ts`): the JWT
 * shape, the tag check, UTF-8 claims, every base64 padding remainder, and the
 * same results without Node's `Buffer` (AGENTS.md item 5).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  checkAppCheckToken,
  checkIdToken,
  latin1FromBase64url,
  signAppCheckToken,
  signIdToken,
} from '../../../src/sandbox/internal/index.js';

const CLAIMS = {
  iss: 'https://securetoken.google.com/demo-project',
  aud: 'demo-project',
  sub: 'uid-1',
  user_id: 'uid-1',
  iat: 1_700_000_000,
  exp: 1_700_003_600,
  name: 'Builder One',
};
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const savedBuffer = (globalThis as { Buffer?: unknown }).Buffer;

afterEach(() => {
  (globalThis as { Buffer?: unknown }).Buffer = savedBuffer;
});

/** Claims whose payload segment lands on each base64 padding remainder: UTF-8 lengths 0, 1 and 2 past a multiple of 3. */
function paddingCases(): Record<string, unknown>[] {
  return [0, 1, 2].map((extra) => ({ ...CLAIMS, pad: 'x'.repeat(extra) }));
}

/** The same character position with any other base64url character. */
function editAt(token: string, index: number): string {
  const current = token[index]!;
  const replacement = BASE64URL[(BASE64URL.indexOf(current) + 1) % BASE64URL.length]!;
  return `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
}

async function roundTripEach(): Promise<unknown[]> {
  const cases = [CLAIMS, { ...CLAIMS, name: '李' }, {}, ...paddingCases()];
  const out: unknown[] = [];
  for (const claims of cases) {
    const token = await signIdToken(claims);
    out.push({ token, check: await checkIdToken(token) });
  }
  return out;
}

describe('sandbox ID tokens', () => {
  it('signs a three-segment JWT with the sandbox header', async () => {
    const token = await signIdToken(CLAIMS);
    const segments = token.split('.');
    expect(segments).toHaveLength(3);
    expect(JSON.parse(latin1FromBase64url(segments[0]!))).toEqual({ alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' });
    // 256 bytes, the length of a real RS256 signature, is 342 base64url characters.
    expect(segments[2]).toHaveLength(342);
  });

  it('checks a token it signed and returns its header and claims', async () => {
    const check = await checkIdToken(await signIdToken(CLAIMS));
    expect(check).toEqual({ ok: true, header: { alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' }, claims: CLAIMS });
  });

  it('round-trips the names Builder One and 李', async () => {
    for (const name of ['Builder One', '李']) {
      const check = await checkIdToken(await signIdToken({ ...CLAIMS, name }));
      expect(check.ok).toBe(true);
      if (check.ok) expect(check.claims.name).toBe(name);
    }
  });

  it('round-trips a payload on each base64 padding remainder', async () => {
    const remainders = new Set<number>();
    for (const claims of paddingCases()) {
      const token = await signIdToken(claims);
      remainders.add(token.split('.')[1]!.length % 4);
      const check = await checkIdToken(token);
      expect(check.ok).toBe(true);
      if (check.ok) expect(check.claims).toEqual(claims);
    }
    expect([...remainders].sort()).toEqual([0, 2, 3]);
  });

  it('fails the check when any character of the header, payload or tag is edited', async () => {
    const token = await signIdToken(CLAIMS);
    const accepted: number[] = [];
    for (let index = 0; index < token.length; index++) {
      if (token[index] === '.') continue;
      if ((await checkIdToken(editAt(token, index))).ok) accepted.push(index);
    }
    expect(accepted).toEqual([]);
  });

  it('reports an edited payload as a signature failure with the edited claims', async () => {
    const [header, , tag] = (await signIdToken(CLAIMS)).split('.');
    const [, forged] = (await signIdToken({ ...CLAIMS, name: 'admin' })).split('.');
    const check = await checkIdToken(`${header}.${forged}.${tag}`);
    expect(check.ok).toBe(false);
    if (!check.ok && check.reason !== 'malformed') {
      expect(check.reason).toBe('signature');
      expect(check.claims.name).toBe('admin');
    } else throw new Error('expected the token to decode');
  });

  it('refuses an App Check token, and App Check refuses an ID token', async () => {
    const appCheck = await signAppCheckToken({ alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' }, CLAIMS);
    const asIdToken = await checkIdToken(appCheck);
    expect(asIdToken.ok).toBe(false);
    if (!asIdToken.ok) expect(asIdToken.reason).toBe('signature');
    const asAppCheck = await checkAppCheckToken(await signIdToken(CLAIMS));
    expect(asAppCheck.ok).toBe(false);
    if (!asAppCheck.ok) expect(asAppCheck.reason).toBe('signature');
  });

  it('reports a kid that names another key', async () => {
    const [, payload, tag] = (await signIdToken(CLAIMS)).split('.');
    const header = btoa(JSON.stringify({ alg: 'RS256', kid: 'other', typ: 'JWT' })).replace(/=+$/, '');
    const check = await checkIdToken(`${header}.${payload}.${tag}`);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('kid');
  });

  it('reports a token that is not a JWT as malformed', async () => {
    for (const token of ['', 'sandbox-id-token-uid-1:{}', 'a.b', 'e30.bm90IGpzb24.sig']) {
      expect(await checkIdToken(token)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('signs and checks the same without the Node Buffer global', async () => {
    const withBuffer = await roundTripEach();
    delete (globalThis as { Buffer?: unknown }).Buffer;
    expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe('undefined');
    const withoutBuffer = await roundTripEach();
    expect(withoutBuffer).toEqual(withBuffer);
  });
});
