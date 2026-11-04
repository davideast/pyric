/**
 * Firebase AI Logic's App Check gate, as the sandbox plays it.
 *
 * What AI Logic answers a request without a valid App Check token depends on
 * the project. Enforcement is required from a date each project can set, up to
 * January 21, 2027, and an unenforced project may answer 200 until then. The
 * sandbox always refuses, as an enforced project does, so an app finds the
 * missing token before production does: a request with no `X-Firebase-AppCheck`
 * header, a malformed one, the web SDK's placeholder token, or a token whose
 * signature fails gets HTTP 401 `UNAUTHENTICATED`, the envelope an enforced
 * project answered (capture `app-check-ai-gate-wire`, enforcement `ENFORCED`),
 * before any engine runs. A valid token answers. The 403 `PERMISSION_DENIED`
 * the sandbox sent before came from an unenforced project and is kept in
 * `earlier-captures/ai-logic-refusal-unenforced.json`. See #1300.
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
 * as a `console.warn` in the page or process. A server process (a registered
 * Node process, a server-rendered module) gets its own guidance: the reCAPTCHA
 * providers throw there and it has no `self`, so it sets the debug token on
 * `globalThis` beside a CustomProvider, as `build/ai-logic.md` shows (#1639).
 * A page's workers are browser realms: they have no `document`, but `self`
 * works there, so they keep the page guidance.
 */
import type { FirebaseApp } from '../app/types.js';
import { appCheckActivationOf, appCheckTokenFor } from '../sandbox/internal/app-check-activation.js';
import { APP_CHECK_PLACEHOLDER_TOKEN, checkAppCheckToken } from '../sandbox/internal/app-check-token.js';
import type { AppCheckClaim, WireErrorEnvelope } from './broker/types.js';
import { RequestHeadersFailure } from './errors.js';

/** An enforced project's message for a refused request (capture `app-check-ai-gate-wire`), verbatim. */
export const APP_CHECK_REQUIRED_MESSAGE = 'Firebase App Check token is invalid.';

/** An enforced project's HTTP status and status for a refused request (capture `app-check-ai-gate-wire`). */
const APP_CHECK_REQUIRED_CODE = 401;
const APP_CHECK_REQUIRED_STATUS = 'UNAUTHENTICATED';

/**
 * The refusal sentence both hints open with. Enforcement is a per-project
 * setting in production, and the sandbox plays an enforced project (#1834).
 * Keep it short: the dev server cuts terminal text at 512 characters
 * (`AI_TERMINAL_TEXT_MAX` in the CLI's `ai-terminal-text.ts`), and
 * {@link APP_CHECK_HINT} must fit whole.
 */
export const APP_CHECK_REFUSAL_NOTE =
  'The sandbox refuses AI Logic requests without an App Check token with a 401, like an enforced project. In production, enforcement is set per project; one that delayed it answers without a token until January 21, 2027.';

/** Pyric's guidance for a page, printed beside production's error, never in place of it. */
export const APP_CHECK_HINT =
  `${APP_CHECK_REFUSAL_NOTE} Call initializeAppCheck(app, { provider }) before getAI(app). For local development, set self.FIREBASE_APPCHECK_DEBUG_TOKEN = true before initializeAppCheck to use the debug provider; the sandbox accepts its tokens. https://firebase.google.com/docs/ai-logic/app-check`;

/** Pyric's guidance for a server process, where reCAPTCHA throws and `self` does not exist. */
export const APP_CHECK_SERVER_HINT =
  `${APP_CHECK_REFUSAL_NOTE} This process has no document, so the reCAPTCHA providers throw here. For local development, set globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true, then call initializeAppCheck(app, { provider: new CustomProvider({ getToken }) }) before getAI(app). The sandbox does not call getToken while the debug token is set. Without the debug token, getToken returns { token, expireTimeMillis: Date.now() + ttlMillis } from a token your server mints with firebase-admin's getAppCheck().createToken(appId). https://firebase.google.com/docs/ai-logic/app-check`;

/**
 * The guidance for the realm the app runs in. A page has a `document`, and a
 * page's Web Worker, SharedWorker or service worker has `WorkerGlobalScope`:
 * both are browser realms. Anything else is a server process.
 */
function appCheckHintForThisRealm(): string {
  const scope = globalThis as { document?: unknown; WorkerGlobalScope?: unknown };
  const hasDocument = typeof scope.document !== 'undefined';
  const isWorkerRealm = typeof scope.WorkerGlobalScope !== 'undefined';
  const isBrowserRealm = hasDocument || isWorkerRealm;
  if (isBrowserRealm) return APP_CHECK_HINT;
  return APP_CHECK_SERVER_HINT;
}

/** The refusal envelope an enforced project answered (capture `app-check-ai-gate-wire`). */
export function appCheckRequired(): WireErrorEnvelope {
  return { error: { code: APP_CHECK_REQUIRED_CODE, message: APP_CHECK_REQUIRED_MESSAGE, status: APP_CHECK_REQUIRED_STATUS } };
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
  const isBrokerRefusal = envelope?.error.code === APP_CHECK_REQUIRED_CODE && envelope.error.message === APP_CHECK_REQUIRED_MESSAGE;
  if (isBrokerRefusal) return true;
  const sdkError = error as { customErrorData?: { status?: unknown }; message?: unknown } | null;
  const isSdkRefusal = sdkError?.customErrorData?.status === APP_CHECK_REQUIRED_CODE
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
  console.warn(`[pyric/ai] ${appCheckHintForThisRealm()}`);
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
