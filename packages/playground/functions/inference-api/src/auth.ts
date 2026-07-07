/**
 * Auth + CORS gate for the deployed public inference Cloud Function
 * (#766).
 *
 * BEFORE this change the function was `invoker: 'public'` with wide-open
 * CORS (`Access-Control-Allow-Origin: *`) and no auth of any kind — any
 * origin could drive the BYOK relay (quota drain, and, before #760, an
 * SSRF via the ollama provider).
 *
 * This module is a pure, dependency-free request evaluator so it can be
 * unit-tested without a running server. It enforces, in order:
 *
 *   1. CORS locked to an allowlist of playground origins (never `*`).
 *   2. A same-origin gate: the request `Origin` (or `Referer` origin)
 *      MUST be in the allowlist. This blocks browser-based abuse from
 *      any other web origin. It is NOT sufficient alone — a non-browser
 *      client can spoof `Origin` — which is why (3) exists.
 *   3. A shared-secret bearer / App-Check token gate. When
 *      `INFERENCE_ACCESS_TOKEN` is configured, requests MUST present a
 *      matching `Authorization: Bearer <token>` (or `X-Firebase-AppCheck`
 *      header). This is the enforceable auth the acceptance criteria
 *      require; it is wired end-to-end (the client injects the token from
 *      `PUBLIC_INFERENCE_ACCESS_TOKEN`).
 *
 * DEFERRED / durable fix: a browser-shipped shared secret raises the bar
 * but is not a true secret. The durable fix is Firebase App Check
 * (cryptographic app attestation, verified server-side with
 * firebase-admin). The `X-Firebase-AppCheck` header is already accepted
 * here so that verification can be added additively without another wire
 * change. See #761.
 */

/** Minimal header bag — case-insensitive `.get` over `IncomingHttpHeaders`. */
export interface HeaderLookup {
  get(name: string): string | undefined;
}

/** Build a case-insensitive lookup from Node's `req.headers`. */
export function headerLookup(headers: Record<string, string | string[] | undefined>): HeaderLookup {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    flat[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v);
  }
  return { get: (name) => flat[name.toLowerCase()] };
}

export interface AuthConfig {
  /** Allowlisted request origins (exact `https://host` strings). */
  allowedOrigins: ReadonlySet<string>;
  /** Shared secret required as a bearer / App-Check token. When empty,
   *  the token gate is not enforced (Origin gate + CORS still apply) and
   *  a warning is surfaced. */
  accessToken: string;
}

/** Default playground hosting origins. Firebase Hosting serves each site
 *  at both `<site>.web.app` and `<site>.firebaseapp.com`. */
const DEFAULT_ORIGINS = [
  'https://pyric-playground.web.app',
  'https://pyric-playground.firebaseapp.com',
  'https://digame-mas.web.app',
  'https://digame-mas.firebaseapp.com',
];

/**
 * Read the auth config from the environment.
 *   - `INFERENCE_ALLOWED_ORIGINS` — comma-separated origin allowlist
 *     (overrides the defaults entirely when set).
 *   - `INFERENCE_ACCESS_TOKEN` — shared-secret token; when set, required.
 */
export function loadAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const raw = env.INFERENCE_ALLOWED_ORIGINS?.trim();
  const origins = raw
    ? raw
        .split(',')
        .map((s) => s.trim().replace(/\/+$/, ''))
        .filter(Boolean)
    : DEFAULT_ORIGINS;
  return {
    allowedOrigins: new Set(origins),
    accessToken: (env.INFERENCE_ACCESS_TOKEN ?? '').trim(),
  };
}

/** Extract the request origin — the `Origin` header, falling back to the
 *  origin of `Referer`. Returns undefined when neither is present. */
export function requestOrigin(headers: HeaderLookup): string | undefined {
  const origin = headers.get('origin');
  if (origin) return origin.replace(/\/+$/, '');
  const referer = headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function bearerToken(headers: HeaderLookup): string | undefined {
  const auth = headers.get('authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!.trim();
  }
  const appCheck = headers.get('x-firebase-appcheck');
  return appCheck?.trim() || undefined;
}

export interface AuthDecision {
  /** True when the request may proceed to the relay. */
  allowed: boolean;
  /** HTTP status to send when `allowed` is false. */
  status: number;
  /** Machine-readable reason (for the JSON body + logging). */
  reason: string;
  /** The origin to echo in `Access-Control-Allow-Origin`, or null when
   *  the origin is not allowlisted (no CORS grant). */
  corsOrigin: string | null;
}

/** Timing-safe-ish string compare (constant time over the shorter len).
 *  Not cryptographic-grade, but avoids a trivial early-exit oracle. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Evaluate a request against the auth + CORS policy. Pure — takes the
 * method, a header lookup, and config; returns a decision. The caller
 * turns the decision into headers + a response.
 */
export function evaluateRequest(
  method: string,
  headers: HeaderLookup,
  config: AuthConfig,
): AuthDecision {
  const origin = requestOrigin(headers);
  const originAllowed = origin != null && config.allowedOrigins.has(origin);
  const corsOrigin = originAllowed ? origin : null;

  // Preflight: answer with the CORS grant (if any); never runs the relay.
  if (method.toUpperCase() === 'OPTIONS') {
    return { allowed: false, status: 204, reason: 'preflight', corsOrigin };
  }

  // (2) Origin allowlist gate.
  if (!originAllowed) {
    return { allowed: false, status: 403, reason: 'origin_not_allowed', corsOrigin: null };
  }

  // (3) Shared-secret token gate (enforced only when configured).
  if (config.accessToken) {
    const token = bearerToken(headers);
    if (!token || !safeEqual(token, config.accessToken)) {
      return { allowed: false, status: 401, reason: 'missing_or_invalid_token', corsOrigin };
    }
  }

  return { allowed: true, status: 200, reason: 'ok', corsOrigin };
}

/** CORS response headers for a decision. Origin-scoped, never `*`. */
export function corsHeaders(decision: AuthDecision): Record<string, string> {
  const h: Record<string, string> = { Vary: 'Origin' };
  if (decision.corsOrigin) {
    h['Access-Control-Allow-Origin'] = decision.corsOrigin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Firebase-AppCheck';
    h['Access-Control-Max-Age'] = '3600';
  }
  return h;
}
