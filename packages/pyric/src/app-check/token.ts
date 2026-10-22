/**
 * Sandbox App Check tokens with production's shape (capture
 * `app-check-client-debug-get-token`): a three-segment JWT, header `alg`
 * RS256, `typ` JWT, a `kid`; claims `aud`, `exp`, `iat`, `iss`, `jti`,
 * `provider`, `sub`; `iss` and `aud` name the project number from the app id;
 * one hour between `iat` and `exp`. The signature is random bytes: nothing in
 * the sandbox verifies it.
 */
const TTL_SECONDS = 3600;
const ISSUER = 'https://firebaseappcheck.googleapis.com';
const SIGNATURE_BYTES = 256;

export interface AppIdentity {
  appId: string;
  projectId: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** The project number a web app id carries: `1:<projectNumber>:web:<hash>`. */
export function projectNumberOf(appId: string): string {
  return appId.split(':')[1] ?? '';
}

export interface MintedToken {
  token: string;
  expireTimeMillis: number;
}

export function mintToken(identity: AppIdentity, nowMillis: number = Date.now()): MintedToken {
  const iat = Math.floor(nowMillis / 1000);
  const exp = iat + TTL_SECONDS;
  const projectNumber = projectNumberOf(identity.appId);
  const header = { alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' };
  const payload = {
    sub: identity.appId,
    aud: [`projects/${projectNumber}`, `projects/${identity.projectId}`],
    provider: 'pyric-sandbox',
    iss: `${ISSUER}/${projectNumber}`,
    exp,
    iat,
    jti: base64url(randomBytes(32)),
  };
  const token = `${encodeJson(header)}.${encodeJson(payload)}.${base64url(randomBytes(SIGNATURE_BYTES))}`;
  return { token, expireTimeMillis: exp * 1000 };
}
