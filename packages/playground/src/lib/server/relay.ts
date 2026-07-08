/**
 * Single relay instance shared by the Astro dev endpoints and the
 * deployed Cloud Function. All the heavy lifting now lives in
 * `@inbrowser/resumable` + `@inbrowser/relay`; this file is just the
 * wiring: pick a JobStore, pick providers, hand the assembled relay
 * to both Astro routes and the function entry.
 *
 * Service-account discovery preserves the prior behaviour:
 *   - $DEPLOY_SA_PATH if set
 *   - `sa.json` next to this module / a parent (the deploy ships it
 *     beside the function bundle; gitignored)
 *   - `ignored/digame-mas-service-account.json` walked up to the repo
 *     root (local dev)
 *
 * Auth scopes for RTDB REST are the default
 * `firebase.database` + `userinfo.email` — the metadata-server
 * `cloud-platform` token isn't sufficient (proven in PR #327).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRtdbJobStore, serviceAccountTokenProvider } from '@inbrowser/resumable';
import {
  createRelay,
  type ModelClientFactory,
  type ModelEvent,
  type NormalizedRequest,
} from '@inbrowser/relay';
// In-repo page-direct providers (NOT the relay's): published
// `@inbrowser/relay@0.4.0` moved its cloud providers into
// `@inbrowser/model` as `ModelClient` factories, which the playground
// doesn't depend on. These in-repo providers emit the playground's flat
// `InferenceEvent`; `flatProviderToFactory` wraps each into the
// `ModelClientFactory` the relay's `providers` map now expects, mapping
// the flat events onto the relay's `ModelEvent`. The same modules drive
// the page-direct fallback, so both transports send identical wire
// bodies. Isomorphic — plain fetch+SSE.
import { geminiProvider } from '~/lib/llm/inference/gemini-page';
import { openrouterPageProvider } from '~/lib/llm/inference/openrouter-page';
import type { InferenceEvent } from '~/lib/llm/inference/openrouter-page';
import { assertNoUserBaseUrlProvider } from './server-providers';

/** The flat page-direct provider shape — takes a full
 *  `NormalizedRequest` and streams the playground's flat
 *  `InferenceEvent`. */
type FlatProvider = (req: NormalizedRequest) => AsyncIterable<InferenceEvent>;

/**
 * Wrap a flat page-direct provider into the `ModelClientFactory` the
 * relay's `providers` map holds. The relay constructs one client per
 * request from `{ apiKey, model }` and drives `.chat(modelRequest,
 * signal)`; we rebuild the `NormalizedRequest` the flat provider wants
 * and translate its flat `InferenceEvent`s onto the relay's `ModelEvent`.
 */
function flatProviderToFactory(provider: FlatProvider, providerKey: string): ModelClientFactory {
  return ({ apiKey, model }) => ({
    id: `${providerKey}:${model}`,
    supportsTools: true,
    async *chat(req, signal): AsyncIterable<ModelEvent> {
      const flatReq: NormalizedRequest = {
        ...req,
        provider: providerKey,
        model,
        ...(apiKey ? { apiKey } : {}),
        ...(signal ? { signal } : {}),
      };
      for await (const ev of provider(flatReq)) {
        switch (ev.kind) {
          case 'text':
            yield { kind: 'text', text: ev.chunk };
            break;
          case 'thinking':
            yield { kind: 'thinking', text: ev.chunk };
            break;
          case 'tool_call':
            yield {
              kind: 'tool_call',
              id: ev.callId,
              name: ev.name,
              args: ev.args,
              ...(ev.signature ? { signature: ev.signature } : {}),
            };
            break;
          case 'usage':
            yield {
              kind: 'usage',
              usage: {
                promptTokens: ev.promptTokens,
                outputTokens: ev.outputTokens,
                ...(typeof ev.cachedTokens === 'number' ? { cachedTokens: ev.cachedTokens } : {}),
                ...(typeof ev.costUsd === 'number' ? { costUsd: ev.costUsd } : {}),
              },
            };
            break;
          case 'error':
            yield { kind: 'error', message: ev.message };
            break;
        }
      }
    },
  });
}

const RTDB_URL = 'https://digame-mas-default-rtdb.firebaseio.com';
const ROOT_PATH = 'inference_jobs';
// 7-day default retention. Configurable per deploy; cleanup must not
// affect running jobs.
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Read env vars by walking up from this file looking for a `.env` and
 * parsing it inline. The reason this exists: Vite's SSR module runner
 * statically replaces `process.env` with `{}` inside modules it
 * evaluates (a sane default for production where secrets shouldn't
 * land in bundles). That means `process.env.PARITY_SA_BASE64` is
 * always undefined inside Astro dev's SSR — even when the host
 * process has the var set via `bun --env-file`. Parsing the file
 * ourselves sidesteps the issue entirely; we own the read.
 *
 * Only invoked at module init, only looks for keys we explicitly
 * ask about. No globbing, no eager parse of everything in the file.
 */
function readEnvFromDisk(): Record<string, string> {
  const out: Record<string, string> = {};
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = resolve(dir, '.env');
    // Skip the existsSync guard — try-readFileSync gives us the same
    // "file missing" signal without bouncing through a separate stat
    // call (which has shown false-negatives in this SSR context).
    try {
      const txt = readFileSync(candidate, 'utf-8');
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
        if (!m) continue;
        const k = m[1]!;
        let v = m[2]!.trim();
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        if (out[k] === undefined) out[k] = v;
      }
    } catch {
      // File missing or unreadable — keep walking.
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

const diskEnv = readEnvFromDisk();

type SaSource =
  | { kind: 'file'; path: string }
  | { kind: 'json'; json: Record<string, unknown> };

/**
 * Locate a service-account credential for the RTDB-backed job store.
 * Resolution order:
 *
 *   1. `DEPLOY_SA_PATH` env — explicit path override (CI / docker).
 *   2. `PARITY_SA_BASE64` / `DEPLOY_SA_JSON_BASE64` env — base64-
 *      encoded SA JSON. The repo's root `.env` already carries
 *      `PARITY_SA_BASE64`; loading the root .env via the dev script
 *      (`bun --env-file=../../.env astro dev`) makes this Just Work
 *      locally without ever putting a JSON file on disk.
 *   3. Walk up from the function's directory looking for
 *      `sa.json` (deploy-shipped) or `ignored/digame-mas-service-account.json`.
 */
function findServiceAccount(): SaSource {
  // Lookup order — favors the full-permission deploy SA over any
  // limited env var. The deploy SA can write RTDB; the parity-test-
  // runner SA can NOT (it's scoped for parity tests). Order:
  //
  //   1. DEPLOY_SA_JSON_BASE64 (explicit override)
  //   2. DEPLOY_SA_PATH        (explicit override)
  //   3. `sa.json` walked up from this module (deploy bundles it)
  //   4. `ignored/digame-mas-service-account.json` walked up
  //   5. PARITY_SA_BASE64      (last-resort fallback — limited perms;
  //                              expected to 401 on RTDB writes,
  //                              left in only so the relay constructs
  //                              instead of crashing)
  const b64Explicit =
    diskEnv.DEPLOY_SA_JSON_BASE64 ?? process.env.DEPLOY_SA_JSON_BASE64;
  if (b64Explicit) return decodeBase64Sa(b64Explicit);
  const saPath = diskEnv.DEPLOY_SA_PATH ?? process.env.DEPLOY_SA_PATH;
  if (saPath) return { kind: 'file', path: saPath };
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    for (const candidate of [
      resolve(dir, 'sa.json'),
      resolve(dir, 'ignored', 'digame-mas-service-account.json'),
    ]) {
      if (existsSync(candidate)) return { kind: 'file', path: candidate };
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  const b64Parity = diskEnv.PARITY_SA_BASE64 ?? process.env.PARITY_SA_BASE64;
  if (b64Parity) return decodeBase64Sa(b64Parity);
  throw new Error(
    'rtdb: no service account found. The deploy ships sa.json with the function; ' +
      'for local dev, place a credentialed SA at ' +
      'ignored/digame-mas-service-account.json, or set DEPLOY_SA_PATH / ' +
      'DEPLOY_SA_JSON_BASE64.',
  );
}

function decodeBase64Sa(b64: string): SaSource {
  try {
    const json = JSON.parse(
      Buffer.from(b64, 'base64').toString('utf-8'),
    ) as Record<string, unknown>;
    return { kind: 'json', json };
  } catch (e) {
    throw new Error(
      `rtdb: failed to decode base64 service-account env var: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

function emit(level: string, msg: string, fields?: Record<string, unknown>): void {
  try {
    console.log(
      JSON.stringify({
        src: 'inference-fn',
        level,
        event: msg,
        ts: Date.now(),
        ...fields,
      }),
    );
  } catch {
    console.log(`inference-fn ${level} ${msg}`);
  }
}

/**
 * Assemble a relay over the shared RTDB job store + base cloud
 * providers, optionally extended with deployment-specific providers.
 * The Cloud Function uses the bare `relay` below; the Astro endpoints
 * use `~/lib/server/relay-local.ts`. The extension point lives HERE
 * (not a mutated singleton) so this module stays free of deploy-only
 * or local-only imports.
 */
export function createPlaygroundRelay(
  extraProviders: Record<string, ModelClientFactory> = {},
  apiKeys: Record<string, string> = {},
): ReturnType<typeof createRelay> {
  const saSource = findServiceAccount();
  // Fail loudly at module init if a user-base-URL (SSRF-prone) provider —
  // `ollama` / `llamaServer` — was ever registered server-side, including
  // via `extraProviders`. See src/lib/server/server-providers.ts (#766).
  const providers: Record<string, ModelClientFactory> = {
    // Only fixed-endpoint providers may run in the SERVER relay (Astro
    // route + the public inference Cloud Function). `ollama` is
    // deliberately excluded: it treats the caller's BYOK field as a base
    // URL, which on the server is an SSRF primitive (the fetch runs with
    // the server's network reachability — e.g. the GCP metadata endpoint
    // and other internal hosts). Ollama stays on the browser page-direct
    // transport (see src/lib/llm/inference/index.ts), where the base URL
    // means the end-user's own machine.
    gemini: flatProviderToFactory(geminiProvider, 'gemini'),
    openrouter: flatProviderToFactory(openrouterPageProvider, 'openrouter'),
    ...extraProviders,
  };
  assertNoUserBaseUrlProvider(Object.keys(providers));
  return createRelay({
    store: createRtdbJobStore({
      url: RTDB_URL,
      auth: serviceAccountTokenProvider(
        saSource.kind === 'file'
          ? { keyFile: saSource.path }
          // The TokenProvider's `keyJson` expects a typed ServiceAccount;
          // we cast through unknown so the decoded object flows in without
          // re-declaring the type here.
          : { keyJson: saSource.json as unknown as Parameters<typeof serviceAccountTokenProvider>[0]['keyJson'] },
      ),
      rootPath: ROOT_PATH,
      defaultTtlMs: DEFAULT_TTL_MS,
      onWarn: (msg, fields) => logger.warn(msg, fields),
    }),
    providers,
    ...(Object.keys(apiKeys).length > 0 ? { apiKeys } : {}),
    logger,
  });
}

/** The Cloud Function's relay -- base providers only. Constructed at
 *  module init exactly as before. */
export const relay = createPlaygroundRelay();
