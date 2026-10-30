/**
 * Firebase AI Logic's App Check gate, as the sandbox plays it.
 *
 * From November 2, 2026 AI Logic requires App Check on every project. A
 * request with no `X-Firebase-AppCheck` header, a malformed one, the web SDK's
 * placeholder token, or a token whose signature fails gets HTTP 403
 * `PERMISSION_DENIED` (capture `app-check-ai-gate-wire`, `noHeader.raw`), and
 * a valid token answers. The sandbox broker refuses the same requests with the
 * same envelope before any engine runs.
 *
 * The App Check claim a request carries comes from the handle: `getAI(app)`
 * reads the app's App Check activation when it builds the handle, as the SDK's
 * AI service reads the provider it was constructed with, so a handle built
 * before `initializeAppCheck` never attaches a token (capture
 * `app-check-client-get-token-before-initialize`). Handles with no app
 * (`getAI(sandbox)`, `createConfiguredSandboxAI`) carry no claim and are not
 * gated: production has no such handle.
 *
 * The error the app gets stays production's. Pyric's guidance rides beside
 * it: on the `request_rejected` event the dev server prints, and once per app
 * as a `console.warn` in the page or process.
 */
import type { FirebaseApp } from '../app/types.js';
import { appCheckActivationOf, appCheckTokenFor } from '../sandbox/internal/app-check-activation.js';
import { APP_CHECK_PLACEHOLDER_TOKEN, checkAppCheckToken } from '../sandbox/internal/app-check-token.js';
import type { AppCheckClaim, WireErrorEnvelope } from './broker/types.js';
import { RequestHeadersFailure } from './errors.js';

/** Production's message for a refused request (capture `app-check-ai-gate-wire`), verbatim. */
export const APP_CHECK_REQUIRED_MESSAGE =
  'Firebase AI Logic has been deactivated in this project. To resume using Firebase AI Logic, you must enforce Firebase App Check. Learn more: https://firebase.google.com/docs/ai-logic/app-check';

/** Pyric's guidance, printed beside production's error, never in place of it. */
export const APP_CHECK_HINT =
  'Firebase AI Logic refuses requests without an App Check token, and so does the sandbox. Call initializeAppCheck(app, { provider }) before getAI(app). For local development, set self.FIREBASE_APPCHECK_DEBUG_TOKEN = true before initializeAppCheck to use the debug provider; the sandbox accepts its tokens. https://firebase.google.com/docs/ai-logic/app-check';

/** The captured refusal envelope (`app-check-ai-gate-wire`, `noHeader.raw`). */
export function appCheckRequired(): WireErrorEnvelope {
  return { error: { code: 403, message: APP_CHECK_REQUIRED_MESSAGE, status: 'PERMISSION_DENIED' } };
}

function expiresAfter(claims: Readonly<Record<string, unknown>>, nowMillis: number): boolean {
  const exp = claims.exp;
  return typeof exp === 'number' && exp * 1000 > nowMillis;
}

/**
 * Whether AI Logic would accept this token: one the sandbox signed (the web
 * mirror or `pyric-admin` minted it) that has not expired. A missing,
 * malformed, placeholder, tampered, or expired token is refused.
 */
export async function admitsAppCheckToken(token: string | null, nowMillis: number = Date.now()): Promise<boolean> {
  const isMissing = token === null || token === '';
  if (isMissing) return false;
  if (token === APP_CHECK_PLACEHOLDER_TOKEN) return false;
  const check = await checkAppCheckToken(token);
  if (!check.ok) return false;
  return expiresAfter(check.claims, nowMillis);
}

/** Whether an error is this gate's refusal, as the broker throws it or the SDK error it becomes. */
export function isAppCheckRefusal(error: unknown): boolean {
  const envelope = (error as { envelope?: WireErrorEnvelope } | null)?.envelope;
  const isBrokerRefusal = envelope?.error.code === 403 && envelope.error.message === APP_CHECK_REQUIRED_MESSAGE;
  if (isBrokerRefusal) return true;
  const sdkError = error as { customErrorData?: { status?: unknown }; message?: unknown } | null;
  const isSdkRefusal = sdkError?.customErrorData?.status === 403
    && typeof sdkError.message === 'string'
    && sdkError.message.includes(APP_CHECK_REQUIRED_MESSAGE);
  return isSdkRefusal;
}

/** What an app-backed handle attaches to every request. */
export interface AppCheckAttachment {
  /** The claim this request carries: a token, or `null` when the handle has none. */
  claim(): Promise<AppCheckClaim>;
  /** Log pyric's guidance once for this app, after the gate refused one of its requests. */
  warnRefused(): void;
}

const warnedApps = new WeakSet<object>();

function warnOnce(app: FirebaseApp): void {
  if (warnedApps.has(app)) return;
  warnedApps.add(app);
  console.warn(`[pyric/ai] ${APP_CHECK_HINT}`);
}

/**
 * The token a request carries. A limited-use token request can reject (the
 * provider failed, with no placeholder to fall back on); upstream `getHeaders`
 * lets that rejection reach `makeRequest`'s `catch`, which turns it into
 * `AIError('error', 'Error fetching from <url>: <message>')`.
 */
async function tokenForRequest(app: FirebaseApp, limitedUse: boolean): Promise<string | null> {
  try {
    return await appCheckTokenFor(app, { limitedUse });
  } catch (reason) {
    throw new RequestHeadersFailure(reason);
  }
}

/**
 * The attachment for a handle `getAI(app)` builds now. App Check is read once,
 * here: a handle built before `initializeAppCheck` never attaches a token.
 * With `useLimitedUseAppCheckTokens`, each request takes a fresh limited-use
 * token.
 */
export function appCheckAttachmentFor(app: FirebaseApp, limitedUse: boolean): AppCheckAttachment {
  const activeAtCreation = appCheckActivationOf(app) !== undefined;
  return {
    claim: async () => ({ token: activeAtCreation ? await tokenForRequest(app, limitedUse) : null }),
    warnRefused: () => warnOnce(app),
  };
}
