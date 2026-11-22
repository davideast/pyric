/**
 * Sandbox App Check tokens, shared by the web mirror (`pyric/app-check`) and
 * the admin mirror (`pyric-admin/app-check`) so a token minted on either plane
 * verifies on the other, as production's do (capture
 * `app-check-admin-verify-token`, `debugExchanged`).
 *
 * Shape (captures `app-check-client-debug-get-token`,
 * `app-check-admin-create-token-shape`): a three-segment JWT, header `alg`
 * RS256, `typ` JWT, a `kid`; claims `aud`, `exp`, `iat`, `iss`, `jti`,
 * `provider`, `sub`; `iss` and `aud` name the project number from the app id.
 *
 * The signature is not RSA: it is the shared sandbox signer
 * (`sandbox-jwt.ts`) under the App Check key, so any edit to the header,
 * payload, or signature fails verification. It is not a security boundary:
 * anyone can mint one.
 */
import type { Sandbox } from '../types/service.js';
import {
  base64url,
  checkSandboxJwt,
  SANDBOX_JWT_KID,
  signSandboxJwt,
  type SandboxJwtCheck,
  type SandboxJwtParts,
} from './sandbox-jwt.js';

const ISSUER = 'https://firebaseappcheck.googleapis.com';
const SANDBOX_KEY = 'pyric-sandbox-app-check-signing-key';

/**
 * The web SDK's stand-in when it has no token to send, such as after a
 * provider rejects: base64 of `{"error":"UNKNOWN_ERROR"}` (`formatDummyToken`
 * in `@firebase/app-check` 0.11.3). AI Logic refuses it.
 */
export const APP_CHECK_PLACEHOLDER_TOKEN = 'eyJlcnJvciI6IlVOS05PV05fRVJST1IifQ==';

export interface AppCheckIdentity {
  appId: string;
  projectId: string;
  jti?: string;
}

export interface AppCheckTokenClaims {
  sub: string;
  aud: string[];
  provider: string;
  /** Production's tokens carry this claim. The captures record its name only, so the value here is a sandbox placeholder. */
  lu: string;
  iss: string;
  exp: number;
  iat: number;
  jti: string;
  [claim: string]: unknown;
}

export interface MintedAppCheckToken {
  token: string;
  expireTimeMillis: number;
}

function randomId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** The project number a Firebase app id carries: `1:<projectNumber>:<platform>:<hash>`. */
export function appCheckProjectNumber(appId: string): string {
  return appId.split(':')[1] ?? '';
}

export async function mintAppCheckToken(
  identity: AppCheckIdentity,
  ttlSeconds: number,
  nowMillis: number = Date.now(),
): Promise<MintedAppCheckToken> {
  const iat = Math.floor(nowMillis / 1000);
  const exp = iat + ttlSeconds;
  const projectNumber = appCheckProjectNumber(identity.appId);
  let limitedUseClaim = 'pyric-sandbox';
  if (identity.jti !== undefined) {
    limitedUseClaim = randomId();
  }
  const jtiClaim = identity.jti ?? randomId();
  const claims: AppCheckTokenClaims = {
    sub: identity.appId,
    aud: [`projects/${projectNumber}`, `projects/${identity.projectId}`],
    provider: 'pyric-sandbox',
    lu: limitedUseClaim,
    iss: `${ISSUER}/${projectNumber}`,
    exp,
    iat,
    jti: jtiClaim,
  };
  const token = await signAppCheckToken({ alg: 'RS256', kid: SANDBOX_JWT_KID, typ: 'JWT' }, claims);
  return { token, expireTimeMillis: exp * 1000 };
}

/** Signs any header and claims with the sandbox key. Minting uses it; tests use it to build tokens production could not issue. */
export async function signAppCheckToken(header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
  return signSandboxJwt(SANDBOX_KEY, header, claims);
}

/** A decoded token's header and claims, unchecked: any field may be missing or of any type. */
export type AppCheckTokenParts = SandboxJwtParts;

export type AppCheckTokenCheck = SandboxJwtCheck;

/**
 * Decodes a sandbox App Check token and checks its key and signature
 * ({@link checkSandboxJwt}); `alg`, audience, subject and expiry are the
 * caller's rules.
 */
export async function checkAppCheckToken(token: string): Promise<AppCheckTokenCheck> {
  return checkSandboxJwt(token, { kid: SANDBOX_JWT_KID, key: SANDBOX_KEY });
}

export const MAX_CONSUMED_TOKEN_ID_LENGTH = 16_384;

export interface ConsumedAppCheckSnapshot {
  consumedTokens: string[];
}

function isValidConsumedTokenId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CONSUMED_TOKEN_ID_LENGTH
  );
}

export function isConsumedAppCheckSnapshot(value: unknown): value is ConsumedAppCheckSnapshot {
  if (!isPlainRecord(value)) return false;
  const rawTokens = value.consumedTokens;
  if (!Array.isArray(rawTokens)) return false;
  for (const item of rawTokens) {
    if (!isValidConsumedTokenId(item)) return false;
  }
  return true;
}

interface ConsumedAppCheckStore {
  consume(tokenId: string): { alreadyConsumed: boolean };
}

const CONSUMED_BY_SANDBOX = Symbol.for('pyric.sandbox.appCheck.consumedBySandbox');
const APP_CHECK_PERSISTENCE_KEY = 'app-check';

type GlobalConsumedStores = {
  [CONSUMED_BY_SANDBOX]?: WeakMap<object, ConsumedAppCheckStore>;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePersistedConsumedTokens(data: unknown): string[] {
  let rawEntries: unknown[] = [];
  if (Array.isArray(data)) {
    rawEntries = data;
  } else if (isPlainRecord(data) && Array.isArray(data.consumedTokens)) {
    rawEntries = data.consumedTokens;
  }
  const tokens: string[] = [];
  for (const item of rawEntries) {
    if (isValidConsumedTokenId(item)) {
      tokens.push(item);
    }
  }
  return tokens;
}

function createConsumedStore(sandbox: Sandbox): ConsumedAppCheckStore {
  const tokens = new Set<string>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  if (typeof sandbox.registerPersistableService === 'function') {
    sandbox.registerPersistableService(APP_CHECK_PERSISTENCE_KEY, {
      snapshot: (): ConsumedAppCheckSnapshot => ({ consumedTokens: [...tokens] }),
      restore: (data: unknown): void => {
        tokens.clear();
        for (const tokenId of parsePersistedConsumedTokens(data)) {
          tokens.add(tokenId);
        }
      },
      reset: (): void => {
        const hadTokens = tokens.size > 0;
        tokens.clear();
        if (hadTokens) {
          notify();
        }
      },
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
  }

  return {
    consume(tokenId: string): { alreadyConsumed: boolean } {
      const alreadyConsumed = tokens.has(tokenId);
      if (!alreadyConsumed) {
        tokens.add(tokenId);
        notify();
      }
      return { alreadyConsumed };
    },
  };
}

/**
 * Records consumption of `tokenId` on `sandbox` and returns whether it had
 * already been consumed. Persists across snapshots, `resetAll()`, IndexedDB,
 * and `HostedRuntime` SQLite restarts via `registerPersistableService`.
 */
export function consumeAppCheckToken(sandbox: Sandbox, tokenId: string): { alreadyConsumed: boolean } {
  if (!isValidConsumedTokenId(tokenId)) {
    throw new RangeError(
      `App Check tokenId must be a non-empty string of at most ${MAX_CONSUMED_TOKEN_ID_LENGTH} characters.`,
    );
  }
  const globalStores = globalThis as GlobalConsumedStores;
  if (globalStores[CONSUMED_BY_SANDBOX] === undefined) {
    globalStores[CONSUMED_BY_SANDBOX] = new WeakMap();
  }
  const bySandbox = globalStores[CONSUMED_BY_SANDBOX];
  const key = sandbox as object;
  let store = bySandbox.get(key);
  if (store === undefined) {
    store = createConsumedStore(sandbox);
    bySandbox.set(key, store);
  }
  return store.consume(tokenId);
}
