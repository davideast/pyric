#!/usr/bin/env bun
/**
 * Composed static Pyric Studio site build — `bash scripts/build-site.sh`.
 *
 * Assembles ONE static site under `dist/site/` from pieces that are each
 * already static-hostable, with no server behind any of it:
 *
 *   dist/site/
 *     index.html, assets/…        Studio app (STUDIO_STATIC=1, base "/")
 *     __pyric/sdk/*.js             the SDK + SharedWorker bundles (direct
 *                                  bundleSdk/bundleWorker calls — no `pyric
 *                                  dev` server involved)
 *     __pyric/init.json            the curated demo seed (rules/authUsers/docs)
 *     playground/…                 the playground's STATIC client only (no
 *                                  Cloud Function build, no inference-endpoint.json)
 *     docs/…                       placeholder — the docs track (site/docs-platform)
 *                                  generates the real content
 *     llms.txt                     placeholder, same reason
 *
 * Every piece here is already output:'static'/pure-esbuild; this script's only
 * job is to run each build with the right base path and copy bytes into one
 * tree. It does NOT start a server and does NOT touch Studio/playground UI.
 */
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { $ } from 'bun';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIST = join(ROOT, 'dist', 'site');

function log(msg: string): void {
  console.log(`▸ ${msg}`);
}

async function main(): Promise<void> {
  log('Clean dist/site/');
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  await buildStudio();
  await bundleSdkAndWorker();
  await buildPlayground();
  writeInitJson();
  writeDocsPlaceholder();

  log(`Done → ${DIST}`);
}

// ─── Studio ─────────────────────────────────────────────────────────────

async function buildStudio(): Promise<void> {
  log('Building packages/studio (STUDIO_STATIC=1, base /)');
  const studioDir = join(ROOT, 'packages', 'studio');
  rmSync(join(studioDir, 'dist'), { recursive: true, force: true });
  await $`bun run --cwd ${studioDir} build`.env({
    ...process.env,
    STUDIO_BASE: '/',
    STUDIO_STATIC: '1',
  });
  const appDir = join(studioDir, 'dist', 'app');
  if (!existsSync(appDir)) {
    throw new Error(`build-site: studio build did not produce ${appDir}`);
  }
  log('Copying Studio app → dist/site/');
  cpSync(appDir, DIST, { recursive: true });
}

// ─── SDK + SharedWorker bundles ────────────────────────────────────────

async function bundleSdkAndWorker(): Promise<void> {
  log('Bundling SDK + SharedWorker (direct bundleSdk/bundleWorker — no serve)');
  const bundlerModule = join(
    ROOT,
    'packages',
    'pyric-tools',
    'dist',
    'serve',
    'bundler.js',
  );
  if (!existsSync(bundlerModule)) {
    throw new Error(
      `build-site: ${bundlerModule} is missing — run \`bun run build\` first (pyric-tools must be built).`,
    );
  }
  const { bundleSdk, bundleWorker, defaultSdkEntries } = await import(bundlerModule);

  const sdkOutDir = join(DIST, '__pyric', 'sdk');
  mkdirSync(sdkOutDir, { recursive: true });

  // bundleSdk computes its OWN outDir under a cache root (keyed by content
  // hash) — it doesn't take an arbitrary target dir. Point its cache root at
  // a scratch dir under dist/, build once (noCache: true, this is a one-shot
  // site build, not `pyric dev`'s warm-start path), then copy the bundle's
  // files into the site's __pyric/sdk/.
  const scratchCache = join(ROOT, 'dist', '.site-sdk-cache');
  rmSync(scratchCache, { recursive: true, force: true });
  const sdkResult = await bundleSdk({
    entries: defaultSdkEntries(),
    cacheRoot: scratchCache,
    noCache: true,
  });
  cpSync(sdkResult.outDir, sdkOutDir, { recursive: true });
  rmSync(scratchCache, { recursive: true, force: true });

  // The worker bundle writes directly into the given outDir (no cache-root
  // indirection) — target the site's __pyric/sdk/ so it lands at
  // /__pyric/sdk/worker.js, matching where `worker/entry.ts`'s
  // `fetchInitPayload()` and the page's `new SharedWorker(...)` expect it.
  await bundleWorker({ outDir: sdkOutDir, noCache: true });

  log(`SDK + worker bundled → ${sdkOutDir}`);
}

// ─── Playground (static client only) ──────────────────────────────────

async function buildPlayground(): Promise<void> {
  log('Building packages/playground static client (base /playground/, no Cloud Function)');
  const pgDir = join(ROOT, 'packages', 'playground');
  rmSync(join(pgDir, 'dist'), { recursive: true, force: true });
  // Deliberately skip `scripts/build-fn.ts` (the Cloud Function build) and
  // run `astro build` directly — the static site ships the page-direct
  // client only, never `/api/inference/*` or `/inference-endpoint.json`.
  await $`bun --env-file=../../.env --env-file=.env astro build`.cwd(pgDir).env({
    ...process.env,
    PLAYGROUND_BASE: '/playground/',
  });
  const clientDir = join(pgDir, 'dist', 'client');
  if (!existsSync(clientDir)) {
    throw new Error(`build-site: playground build did not produce ${clientDir}`);
  }
  const target = join(DIST, 'playground');
  mkdirSync(target, { recursive: true });
  // Astro's static output already nests the playground ROUTE under
  // `client/playground/` (from `src/pages/playground.astro`) and keeps
  // shared build assets under `client/_astro/`. Copy both; skip the
  // top-level `client/index.html` (the astro app's OWN root page — the
  // composed site's root is Studio, not this).
  cpSync(join(clientDir, 'playground'), target, { recursive: true });
  const astroAssets = join(clientDir, '_astro');
  if (existsSync(astroAssets)) {
    cpSync(astroAssets, join(target, '_astro'), { recursive: true });
  }
  const favicon = join(clientDir, 'favicon.svg');
  if (existsSync(favicon)) {
    cpSync(favicon, join(target, 'favicon.svg'));
  }
  log(`Playground static client → ${target}`);
}

// ─── Demo seed (__pyric/init.json) ────────────────────────────────────

/** Mirrors `pyric-tools`' `InitPayload` (serve/namespace.ts) — the shape the
 *  SharedWorker's `fetchInitPayload()` expects at `/__pyric/init.json`. Only
 *  the fields the worker actually reads are populated; everything else is
 *  explicit `null`/`false` so the worker's no-serve degrade paths (no
 *  `--persist` server file, no `/__pyric/capture`, no bridge) are exercised
 *  intentionally, not by omission. */
interface SeedFile {
  rules: string;
  authUsers: ReadonlyArray<Record<string, unknown>>;
  seed: Record<string, Record<string, unknown>>;
}

function writeInitJson(): void {
  log('Writing __pyric/init.json (curated demo seed)');
  const seedPath = join(ROOT, 'scripts', 'site', 'seed.json');
  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedFile;

  const initPayload = {
    rules: seed.rules,
    rulesHash: null,
    databaseRules: null,
    databaseRulesHash: null,
    databaseUrl: null,
    // No bridge behind a static site — the worker's bridge-peer connect
    // (`connectStudioBridgePeer`) reads this and no-ops when null.
    bridgeUrl: null,
    seed: seed.seed,
    // No `--persist` server file exists under static hosting — IDB is the
    // only durable tier (see `createWorkerDurableBackend`'s "default" branch).
    persist: false,
    seedState: null,
    authUsers: seed.authUsers,
    // No `/__pyric/capture` route exists under static hosting; leaving this
    // off means the worker never POSTs there.
    capture: false,
  };

  const outDir = join(DIST, '__pyric');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'init.json'), JSON.stringify(initPayload, null, 2));
}

// ─── docs + llms.txt placeholders ──────────────────────────────────────

function writeDocsPlaceholder(): void {
  log('Writing docs/ + llms.txt placeholders');
  const docsDir = join(DIST, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(
    join(docsDir, 'index.html'),
    STUB_HTML(
      'Docs — coming soon',
      'The real docs/ tree is generated by the site/docs-platform track. ' +
        'This is a placeholder stub so the composed static site has SOMETHING ' +
        'at /docs/ until that track lands.',
    ),
  );
  writeFileSync(
    join(DIST, 'llms.txt'),
    [
      '# Pyric — llms.txt (PLACEHOLDER)',
      '',
      'This file is a stub. The real llms.txt is generated by the',
      'site/docs-platform track from the actual docs content.',
      '',
      'Generated by scripts/build-site.sh — do not hand-edit; it will be',
      'overwritten by the next build.',
      '',
    ].join('\n'),
  );
}

function STUB_HTML(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<h1>${title}</h1>
<p>${body}</p>
</body>
</html>
`;
}

await main();
