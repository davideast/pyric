/**
 * Every unsigned custom token shape the sandbox once redeemed unchecked
 * (#2009), each asserting an admin claim for a uid and an `exp` long past.
 */

const ELEVATED = { uid: 'victim-uid', claims: { admin: true } };
const LONG_AGO_SEC = 1_000_000_000;

function base64url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function padded(json: string): string {
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_');
}

const HEADER = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));

/** A custom-token-audience payload whose base64 form ends in `=` padding. */
function paddedPayload(audience: string): string {
  for (let filler = ''; ; filler += 'x') {
    const json = JSON.stringify({ aud: audience, ...ELEVATED, exp: LONG_AGO_SEC, note: filler });
    if (json.length % 3 !== 0) return padded(json);
  }
}

/** The unsigned shapes, by name, for the custom token audience given. */
export function unsignedCustomTokens(audience: string): Record<string, string> {
  const json = JSON.stringify({ ...ELEVATED, exp: LONG_AGO_SEC });
  return {
    'the JSON {uid, claims} shape': json,
    'the base64url form of the JSON shape': base64url(json),
    'a JWT for another audience': `${HEADER}.${base64url(JSON.stringify({ aud: 'https://example.com', ...ELEVATED, exp: LONG_AGO_SEC }))}.sig`,
    'a JWT with no aud': `${HEADER}.${base64url(JSON.stringify({ ...ELEVATED, exp: LONG_AGO_SEC }))}.sig`,
    'a JWT with only sub': `${HEADER}.${base64url(JSON.stringify({ sub: 'victim-uid' }))}.sig`,
    'a custom-token-audience JWT whose payload carries = padding': `${HEADER}.${paddedPayload(audience)}.sig`,
  };
}
