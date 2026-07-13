/**
 * Cloud Function Gen 2 entry — production host for the playground's
 * resumable inference server. Deployed to the `digame-mas` project,
 * called cross-origin at its direct Cloud Function URL (the deploy
 * writes that URL to `/inference-endpoint.json`; the client fetches it on
 * load). The Firebase Hosting rewrite path is intentionally bypassed:
 * Hosting buffers SSE end-to-end (proven by debug-stream probes in
 * PR #327).
 *
 * The function reuses the same relay singleton the Astro endpoints
 * use (`src/lib/server/relay.ts`); the `createExpressHandlers` shim
 * from `@inbrowser/relay/adapters/express` adapts the Web-standard
 * relay output to the Functions-Framework `(req, res)` shape.
 *
 * Bundled to `lib/index.js` by `scripts/build-fn.ts` (Bun, target
 * node). Workspace packages (@inbrowser/relay, @inbrowser/resumable,
 * @inbrowser/agent) are bundled in; the only runtime dep is
 * `firebase-functions`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createExpressHandlers } from '@inbrowser/relay';
import { onRequest } from 'firebase-functions/v2/https';
import { relay } from '../../../src/lib/server/relay';
import {
  corsHeaders,
  evaluateRequest,
  headerLookup,
  loadAuthConfig,
} from './auth';

// Surface fatal errors to Cloud Logging before the instance dies.
process.on('unhandledRejection', (reason) => {
  console.log(
    JSON.stringify({
      src: 'inference-fn',
      level: 'error',
      event: 'fatal_unhandled_rejection',
      error: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
      stack: reason instanceof Error ? reason.stack?.slice(0, 1200) : undefined,
      ts: Date.now(),
    }),
  );
});
process.on('uncaughtException', (err) => {
  console.log(
    JSON.stringify({
      src: 'inference-fn',
      level: 'error',
      event: 'fatal_uncaught_exception',
      error: `${err.name}: ${err.message}`,
      stack: err.stack?.slice(0, 1200),
      ts: Date.now(),
    }),
  );
});

// CORS is handled by our own auth gate (origin-scoped, never `*`), so
// the adapter's permissive `cors: true` is DISABLED here (#766).
const { start, stream } = createExpressHandlers(relay, { cors: false });

// Auth + CORS policy, read once at module init.
const authConfig = loadAuthConfig();
if (!authConfig.accessToken) {
  console.log(
    JSON.stringify({
      src: 'inference-fn',
      level: 'warn',
      event: 'auth_token_not_configured',
      msg:
        'INFERENCE_ACCESS_TOKEN is unset — only the Origin allowlist + CORS gate are active. ' +
        'Set INFERENCE_ACCESS_TOKEN (and PUBLIC_INFERENCE_ACCESS_TOKEN on the client) to require a bearer token.',
      ts: Date.now(),
    }),
  );
}

/** Apply the auth + CORS gate. Returns true when the request may proceed
 *  to the relay; otherwise it has already written the response. */
function gate(req: FfRequest, res: ServerResponse): boolean {
  const method = (req.method ?? 'GET').toUpperCase();
  const decision = evaluateRequest(method, headerLookup(req.headers), authConfig);
  for (const [k, v] of Object.entries(corsHeaders(decision))) res.setHeader(k, v);
  if (decision.allowed) return true;
  if (decision.reason === 'preflight') {
    res.statusCode = 204;
    res.end();
    return false;
  }
  res.statusCode = decision.status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: decision.reason }));
  return false;
}

type FfRequest = IncomingMessage & {
  body?: unknown;
  rawBody?: Buffer;
  params?: Record<string, string | undefined>;
};

/**
 * The dispatcher stays framework-light: firebase-functions owns the
 * endpoint metadata while this handler routes URL paths directly.
 */
async function handleInferenceApi(req: FfRequest, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  // Auth + CORS gate first — including OPTIONS preflight. Rejects
  // non-allowlisted origins and (when configured) missing/invalid tokens
  // BEFORE the relay's `handleStart` ever runs (#766).
  if (!gate(req, res)) return;

  if (method === 'POST' && path.endsWith('/inference/job')) {
    await start(req, res);
    return;
  }
  const streamMatch = path.match(/\/inference\/job\/([^/]+)\/stream\/?$/);
  if (method === 'GET' && streamMatch) {
    // The express adapter reads the job id from req.params; we
    // populate it from the regex match.
    req.params = { id: decodeURIComponent(streamMatch[1] ?? '') };
    await stream(req, res);
    return;
  }
  res.statusCode = 404;
  res.end('not found');
}

export const inferenceApi = onRequest(
  {
    region: 'us-central1',
    // Keep the manually configured no-CPU-throttling service setting;
    // firebase-functions does not currently expose that Cloud Run knob.
    preserveExternalChanges: true,
    // One warm 1 GiB instance removes the cold-start penalty while the
    // max keeps this single-user Playground's cost bounded. Concurrency
    // 80 prevents simultaneous agent/stream requests from making the
    // single instance behave as a single-flight service.
    memory: '1GiB',
    timeoutSeconds: 300,
    minInstances: 1,
    maxInstances: 1,
    concurrency: 80,
    // A full CPU is required for Gen 2 concurrency.
    cpu: 1,
    invoker: 'public',
  },
  (req, res) => handleInferenceApi(req as FfRequest, res),
);
