#!/usr/bin/env bun
/**
 * Static Pyric site build — `bash scripts/build-site.sh`.
 *
 * Builds ONE Astro site under `dist/site/`, then adds the static sandbox
 * runtime used by its Studio routes. There is no server behind any of it:
 *
 *   dist/site/
 *     index.html, <service>/…     Astro-owned Studio entry documents
 *     docs/…, _astro/…            Astro-owned docs and shared assets
 *     __pyric/sdk/*.js             the SDK + SharedWorker bundles (direct
 *                                  bundleSdk/bundleWorker calls — no `pyric
 *                                  dev` server involved)
 *     __pyric/init.json            the curated demo seed (rules/authUsers/docs)
 *     llms.txt                     the docs' generated agent entry point
 *     404.html                     the docs' 404 page, copied to the site
 *                                  root so Firebase Hosting serves it for
 *                                  any dead path (no catch-all rewrite
 *                                  swallows misses into a 200'd app shell)
 *
 * The Astro build owns every page and asset. This script only adds the SDK,
 * worker, init payload, and the generation stamp Studio uses to select the
 * same SharedWorker as the application runtime. It does NOT start a server.
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

  await buildSite();
  const workerEpoch = await bundleSdkAndWorker();
  writeInitJson();
  stampStudioEntries(workerEpoch);

  log(`Done → ${DIST}`);
}

// ─── Astro site ─────────────────────────────────────────────────────────

async function buildSite(): Promise<void> {
  log('Building the Studio module and unified Astro site (base /)');
  const studioDir = join(ROOT, 'packages', 'studio');
  await $`bun run --cwd ${studioDir} build:ports`;

  const siteDir = join(ROOT, 'packages', 'site-docs');
  await $`bun run --cwd ${siteDir} build`.env({
    ...process.env,
    DOCS_BASE: '/',
    STUDIO_STATIC: '1',
  });
  const siteDist = join(siteDir, 'dist');
  if (!existsSync(join(siteDist, 'studio-routes.json')) || !existsSync(join(siteDist, 'docs'))) {
    throw new Error(`build-site: Astro build did not produce the unified site at ${siteDist}`);
  }
  cpSync(siteDist, DIST, { recursive: true });
}

// ─── SDK + SharedWorker bundles ────────────────────────────────────────

async function bundleSdkAndWorker(): Promise<string> {
  log('Bundling SDK + SharedWorker (direct bundleSdk/bundleWorker — no serve)');
  const bundlerModule = join(
    ROOT,
    'packages',
    'cli',
    'dist',
    'serve',
    'bundler.js',
  );
  if (!existsSync(bundlerModule)) {
    throw new Error(
      `build-site: ${bundlerModule} is missing — run \`bun run build\` first (@pyric/cli must be built).`,
    );
  }
  const { bundleSdk, bundleWorker, defaultSdkEntries } = await import(bundlerModule);

  const sdkOutDir = join(DIST, '__pyric', 'sdk');
  mkdirSync(sdkOutDir, { recursive: true });

  // bundleSdk computes its OWN outDir under a cache root (keyed by content
  // hash) — it doesn't take an arbitrary target dir. Point its cache root at
  // a scratch dir under dist/, build once (noCache: true, this is a one-shot
  // site build, not `pyric sandbox`'s warm-start path), then copy the bundle's
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
  const worker = await bundleWorker({ outDir: sdkOutDir, noCache: true });

  log(`SDK + worker bundled → ${sdkOutDir}`);
  return worker.epoch;
}

// ─── Demo seed (__pyric/init.json) ────────────────────────────────────

/** Mirrors `@pyric/cli`' `InitPayload` (serve/namespace.ts) — the shape the
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

// ─── SharedWorker generation on Studio documents ──────────────────────

interface StudioRouteManifest {
  routes: string[];
}

function stampStudioEntries(workerEpoch: string): void {
  if (!/^[a-f0-9]{16}$/.test(workerEpoch)) {
    throw new Error(`build-site: invalid SharedWorker epoch ${workerEpoch}`);
  }
  const manifestPath = join(DIST, 'studio-routes.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StudioRouteManifest;
  if (
    !Array.isArray(manifest.routes) ||
    manifest.routes.some((route) => typeof route !== 'string' || route === 'home')
  ) {
    throw new Error(`build-site: invalid Studio route manifest at ${manifestPath}`);
  }

  const entries = [null, ...manifest.routes] as const;
  for (const route of entries) {
    const htmlPath = route === null ? join(DIST, 'index.html') : join(DIST, route, 'index.html');
    const html = readFileSync(htmlPath, 'utf8');
    if (!html.includes('<head>')) {
      throw new Error(`build-site: Studio entry has no <head>: ${htmlPath}`);
    }
    const meta = `<meta name="pyric-worker-v" content="${workerEpoch}">`;
    writeFileSync(htmlPath, html.replace('<head>', `<head>${meta}`));
  }
  log(`Stamped ${entries.length} Studio entries with worker ${workerEpoch}`);
}

await main();
