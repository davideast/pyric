/**
 * One reading of who issued an ID token (#2304 G-1): a sandbox token, a
 * production-shaped token, the replay's token, and malformed strings, read
 * the same with and without Node's `Buffer` and `atob` (AGENTS.md item 5).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { idTokenIssuer, mintIdToken } from '../../src/sandbox/internal/index.js';

const PROJECT = 'demo-project';
const SECURETOKEN_ISS = `https://securetoken.google.com/${PROJECT}`;
const PRODUCTION_KID = '3f5a8c1d9e2b7a6c4d0e1f2a3b4c5d6e7f8a9b0c';

const CLAIMS = {
  iss: SECURETOKEN_ISS,
  aud: PROJECT,
  sub: 'uid-1',
  user_id: 'uid-1',
  iat: 1_700_000_000,
  exp: 1_700_003_600,
};

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function rawSegment(text: string): string {
  return Buffer.from(text).toString('base64url');
}

function token(header: unknown, claims: unknown, signature = 'c2lnbmF0dXJl'): string {
  return `${segment(header)}.${segment(claims)}.${signature}`;
}

const productionToken = token({ alg: 'RS256', kid: PRODUCTION_KID, typ: 'JWT' }, CLAIMS);
const replayToken = token({ alg: 'RS256', kid: 'replay', typ: 'JWT' }, CLAIMS, rawSegment('replay'));

/** Headers whose segment length leaves each base64 remainder (0, 2 and 3 characters). */
function paddingRemainderTokens(): string[] {
  const tokens: string[] = [];
  for (let extra = 0; extra < 3; extra++) {
    const header = { alg: 'RS256', kid: PRODUCTION_KID, typ: 'JWT', x: 'a'.repeat(extra) };
    tokens.push(token(header, CLAIMS));
  }
  return tokens;
}

const PADDING_TOKENS = paddingRemainderTokens();

const MALFORMED: readonly string[] = [
  '',
  'not-a-jwt',
  '..',
  `.${segment(CLAIMS)}.sig`,
  `${segment({ alg: 'RS256', kid: PRODUCTION_KID })}..sig`,
  `${rawSegment('not json')}.${segment(CLAIMS)}.sig`,
  `${segment({ alg: 'RS256', kid: PRODUCTION_KID })}.${rawSegment('not json')}.sig`,
  `${segment(['RS256'])}.${segment(CLAIMS)}.sig`,
  `${segment({ alg: 'RS256', kid: PRODUCTION_KID })}.${segment('claims')}.sig`,
  `${segment({ alg: 'RS256', kid: PRODUCTION_KID })}.${segment(CLAIMS)}`,
  `a.${segment(CLAIMS)}.sig`,
  `${segment({ alg: 'RS256', kid: PRODUCTION_KID })}.${segment(CLAIMS)}.sig.extra`,
  `${segment({ alg: 'RS256', kid: PRODUCTION_KID })}!.${segment(CLAIMS)}.sig`,
];

function readEach(): unknown[] {
  return [
    idTokenIssuer(mintIdToken(CLAIMS)),
    idTokenIssuer(mintIdToken(CLAIMS, 2)),
    idTokenIssuer(productionToken),
    idTokenIssuer(replayToken),
    ...PADDING_TOKENS.map(idTokenIssuer),
    ...MALFORMED.map(idTokenIssuer),
  ];
}

describe('idTokenIssuer', () => {
  const globals = globalThis as { Buffer?: unknown; atob?: unknown };
  const realBuffer = globals.Buffer;
  const realAtob = globals.atob;

  afterEach(() => {
    globals.Buffer = realBuffer;
    globals.atob = realAtob;
  });

  it('reads a sandbox-minted ID token as sandbox', () => {
    expect(idTokenIssuer(mintIdToken(CLAIMS))).toBe('sandbox');
    expect(idTokenIssuer(mintIdToken(CLAIMS, 3))).toBe('sandbox');
  });

  it('reads an RS256 token with a Google key id and a securetoken issuer as production', () => {
    expect(idTokenIssuer(productionToken)).toBe('production');
  });

  it("reads the replay's token as production, the side it stands in for", () => {
    expect(idTokenIssuer(replayToken)).toBe('production');
  });

  it('reads production on every base64 remainder of the header segment', () => {
    const lengths = PADDING_TOKENS.map((each) => each.split('.')[0]!.length % 4);
    expect(new Set(lengths)).toEqual(new Set([0, 2, 3]));
    for (const each of PADDING_TOKENS) expect(idTokenIssuer(each)).toBe('production');
  });

  it('reads a hand-built header with the sandbox key id as sandbox', () => {
    const sandboxHeader = { alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' };
    expect(idTokenIssuer(token(sandboxHeader, CLAIMS))).toBe('sandbox');
  });

  it('reads a token that is not a securetoken RS256 ID token as unknown', () => {
    const header = { alg: 'RS256', kid: PRODUCTION_KID, typ: 'JWT' };
    expect(idTokenIssuer(token(header, { ...CLAIMS, iss: 'https://firebaseappcheck.googleapis.com/1' }))).toBe('unknown');
    expect(idTokenIssuer(token(header, { ...CLAIMS, iss: 'https://securetoken.google.com/' }))).toBe('unknown');
    expect(idTokenIssuer(token(header, { ...CLAIMS, iss: 42 }))).toBe('unknown');
    const { iss: _iss, ...noIss } = CLAIMS;
    expect(idTokenIssuer(token(header, noIss))).toBe('unknown');
    expect(idTokenIssuer(token({ ...header, alg: 'HS256' }, CLAIMS))).toBe('unknown');
    expect(idTokenIssuer(token({ ...header, alg: 'none' }, CLAIMS))).toBe('unknown');
    expect(idTokenIssuer(token({ alg: 'RS256', typ: 'JWT' }, CLAIMS))).toBe('unknown');
    expect(idTokenIssuer(token({ ...header, kid: '' }, CLAIMS))).toBe('unknown');
    expect(idTokenIssuer(token({ ...header, kid: 7 }, CLAIMS))).toBe('unknown');
  });

  it('reads an App Check sandbox token as unknown, since it is not an ID token', () => {
    const appCheckClaims = { iss: 'https://firebaseappcheck.googleapis.com/123', sub: '1:123:web:abc' };
    expect(idTokenIssuer(token({ alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' }, appCheckClaims))).toBe('unknown');
  });

  it('reads malformed strings, empty segments and non-JSON segments as unknown', () => {
    for (const each of MALFORMED) expect(idTokenIssuer(each)).toBe('unknown');
  });

  it('reads every token the same without the Node Buffer global', () => {
    const withBuffer = readEach();
    delete globals.Buffer;
    expect(typeof globals.Buffer).toBe('undefined');
    expect(readEach()).toEqual(withBuffer);
  });

  it('reads every token the same without Buffer or atob', () => {
    const withGlobals = readEach();
    delete globals.Buffer;
    delete globals.atob;
    expect(typeof globals.Buffer).toBe('undefined');
    expect(typeof globals.atob).toBe('undefined');
    expect(readEach()).toEqual(withGlobals);
  });
});
