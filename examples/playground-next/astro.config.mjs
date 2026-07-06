import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';

const shimDir = fileURLToPath(new URL('./src/lib/node-shims', import.meta.url));

/**
 * Fetch the playground's Firebase host config from Firebase Hosting's
 * built-in auto-init endpoint. Any site deployed to Firebase Hosting
 * auto-serves its project's web SDK config at
 * `https://{site}.web.app/__/firebase/init.json` — publicly, no auth.
 *
 * We pin to the deployed playground site so dev and prod share the
 * same host project. The fetch happens at config-resolution time
 * (Astro starting up / building), and the result is inlined into the
 * client bundle via Vite's `define`. No runtime fetch, no CORS issue,
 * no `.env` file required.
 *
 * Self-hosters: change `HOST_INIT_URL` to your deployed site's
 * `/__/firebase/init.json`. No other config touches required.
 *
 * The auto-init payload omits `appId`. Firebase Auth doesn't require
 * it; if a future feature does, fetch the appId via Management API
 * after sign-in and merge it in.
 */
// Self-hosters: change to YOUR deployed Hosting site's auto-init
// endpoint. The playground fetches its Firebase config from this URL
// at build time; Firebase Auth uses that project. Hosting sites are
// auto-authorized on their own project, so sign-in works without a
// separate authorize-domain step.
const HOST_INIT_URL = 'https://digame-mas.web.app/__/firebase/init.json';

async function fetchHostConfig() {
  const res = await fetch(HOST_INIT_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch Firebase host config from ${HOST_INIT_URL}: ${res.status} ${res.statusText}. ` +
        'Check network/proxy. Self-hosters: edit HOST_INIT_URL in astro.config.mjs.',
    );
  }
  return await res.json();
}

const HOST_FIREBASE_CONFIG = await fetchHostConfig();

/**
 * Static-output Astro app — the playground runs entirely in the
 * browser. The agent loop, BYOK, and Firebase Storage save/load all
 * happen client-side.
 *
 * Output stays `static` — the playground page itself is still
 * prerendered and the existing client-only behaviour is unchanged.
 * The `@astrojs/node` adapter is here only so the API routes under
 * `src/pages/api/` that opt out with `prerender = false` (the
 * resumable-server-stream spike — Option C in
 * plans/sw-inference-backgrounding-recovery.md) can run on demand
 * under `astro dev` / `astro preview` for local parity.
 *
 * DEPLOY: `bun run deploy` builds the `/api` routes into a Cloud
 * Function and ships the static client (`dist/client/`) to Firebase
 * Hosting with a `/api/** → function` rewrite — both inference modes
 * live in one deploy. The on-demand routes built here into
 * `dist/server/` are used by `astro preview` only; the Hosting
 * deploy uploads `dist/client/`. See scripts/deploy.ts.
 *
 * Node-stdlib shims: `@pyric/firestore-rules`'s resolver module
 * hard-imports `fs`/`path`/`url` at top level. The playground never
 * invokes the resolver from the browser, but the imports have to
 * resolve for the Vite build. The aliases below point each module
 * at a small shim that returns harmless defaults (joins via '/',
 * strips file:// from URLs).
 *
 * IMPORTANT — the aliases only apply to CLIENT builds. SSR builds
 * (the `/api/inference/*` routes + `@astrojs/node` internals) need
 * the REAL `node:fs` / `node:path` / etc., so the conditional
 * `config()` hook below returns an empty alias array on
 * `isSsrBuild`.
 */
const shimAliases = [
  { find: /^(node:)?fs$/, replacement: `${shimDir}/fs.ts` },
  { find: /^(node:)?path$/, replacement: `${shimDir}/path.ts` },
  { find: /^(node:)?url$/, replacement: `${shimDir}/url.ts` },
  { find: /^(node:)?os$/, replacement: `${shimDir}/os.ts` },
  // `just-bash`'s browser bundle imports `gunzipSync` from
  // `node:zlib` for a `gunzip` builtin we don't exercise from the
  // terminal. Stub it so the production Rollup build resolves the
  // named export; calling it actually throws (see zlib.ts).
  { find: /^(node:)?zlib$/, replacement: `${shimDir}/zlib.ts` },
  // `firebase-admin` + its subpaths are Node-only — pulled in
  // transitively by `@pyric/rtdb`'s top-level re-export of
  // `DataHandler` (which imports `firebase-admin/database`). The
  // playground only consumes the modular surface at preview time, so
  // the client shim returns empty values that satisfy module-load
  // without actually executing admin code. Same client-only
  // discipline as the node:* shims above (SSR builds keep the real
  // `firebase-admin`). See node-shims/firebase-admin.ts for context.
  { find: /^firebase-admin(\/.*)?$/, replacement: `${shimDir}/firebase-admin.ts` },
];

/** Vite plugin — apply the `node:*` shim aliases on CLIENT code only,
 *  leaving SSR code with real Node modules.
 *
 *  The previous shape used `config()` + `env.isSsrBuild`, but that
 *  flag is only set during `vite build`, never during `vite dev`. In
 *  dev mode it left the aliases active for SSR modules too, which
 *  silently stubbed `fs.readFileSync` to `''` and `process.env` to
 *  `{}` inside Astro endpoints — making any file read or env var
 *  access from `src/pages/api/` or `src/lib/server/` invisible.
 *
 *  This `resolveId` hook fires per-import and receives an `{ ssr }`
 *  flag for both dev and build. If the import is from SSR code, we
 *  return `null` (let Vite resolve to the real Node module);
 *  otherwise we point at the shim. */
const clientOnlyNodeShims = {
  name: 'pyric-playground-node-shims-client-only',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (options?.ssr) return null;
    for (const a of shimAliases) {
      if (a.find.test(source)) return a.replacement;
    }
    return null;
  },
};

/** Vite plugin — replace `process.env` literals with `{}` in CLIENT
 *  code only, leaving SSR `process.env` accesses live so Astro
 *  endpoints can read env vars at runtime. The previous shape used
 *  `vite.define['process.env']`, which is global — it broke SSR
 *  reads of `process.env.PARITY_SA_BASE64` and friends because
 *  EVERY `process.env.X` in every module got rewritten to
 *  `({}).X === undefined`. Now the rewrite only fires for non-SSR
 *  code paths. */
const clientOnlyProcessEnvDefine = {
  name: 'pyric-playground-process-env-client-only',
  enforce: 'pre',
  transform(code, id, options) {
    if (options?.ssr) return null;
    if (!/process\.env/.test(code)) return null;
    return {
      code: code.replace(/\bprocess\.env\b/g, '({})'),
      map: null,
    };
  },
};

export default defineConfig({
  output: 'static',
  adapter: node({ mode: 'standalone' }),
  integrations: [react(), tailwind({ applyBaseStyles: true })],
  vite: {
    plugins: [clientOnlyNodeShims, clientOnlyProcessEnvDefine],
    // Pin React to a single copy. Several sibling monorepo examples
    // still pin react@18; without dedupe Vite can pull a second React
    // into this app's module graph, which trips "Invalid hook call /
    // more than one copy of React" (null hook dispatcher).
    resolve: { dedupe: ['react', 'react-dom'] },
    // HMR disabled — mid-test hot reloads wipe playground state (auth,
    // composed prompt, in-flight agent turn). File changes still
    // rebuild; refresh the browser manually to pick them up.
    server: { hmr: false },
    define: {
      // Double-stringify: outer makes a Vite-substitutable string;
      // inner makes the value a JSON string we can `JSON.parse` at
      // runtime. Astro's `import.meta.env.PUBLIC_*` pattern reliably
      // substitutes; bare identifiers don't always thread through
      // Vite's transform in dev.
      'import.meta.env.PUBLIC_FIREBASE_CONFIG': JSON.stringify(
        JSON.stringify(HOST_FIREBASE_CONFIG),
      ),
      // OLLAMA_HOST is the boot-default URL the client uses for both
      // `/api/tags` discovery and inference requests. Inlined here
      // because the process-env rewrite plugin strips `process.env`
      // in client bundles. The BYOK slot's stored URL still wins at
      // runtime — see `resolveOllamaBaseUrl()` in
      // src/lib/llm/ollama.ts for the full precedence chain.
      'import.meta.env.PUBLIC_OLLAMA_HOST': JSON.stringify(
        process.env.OLLAMA_HOST ?? null,
      ),
      // GIS OAuth client id — same pattern. Sourced from the
      // monorepo root .env (loaded by the `build` script's
      // bun --env-file flag) so the deploy bake-in finds it.
      // The local Vite .env loader misses this when the var lives
      // in ../../.env, hence the explicit define.
      'import.meta.env.PUBLIC_GIS_CLIENT_ID': JSON.stringify(
        process.env.PUBLIC_GIS_CLIENT_ID ?? null,
      ),
    },
  },
});
