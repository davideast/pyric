/**
 * `pyric dev` — local dev server with the pyric sandbox standing in for
 * Firebase. Feels like `firebase serve` (banner, labeled lines, port 3473,
 * SIGINT shutdown) with the sandbox-flavored extras firebase can't do: the
 * served page runs an in-browser backend, your `firestore.rules` deploy into
 * it at page load, and unmodified `firebase/*` imports resolve to pyric via a
 * served import map.
 *
 * Orchestration: firebase.json (optional — warn + serve cwd without it) →
 * rules load (fail fast on broken rules) → SDK bundle (cached per pyric
 * version) → static server with the `/__pyric/` namespace + HTML injection.
 */
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { ParsedArgs } from './parse-args.js';
import { readFirebaseJson, type FirebaseJson } from './firebase-json.js';
import { bundleSdk, bundleWorker, defaultSdkEntries, resolvePlaygroundUiDir, resolveStudioUiDir, workerSourceHash } from '../serve/bundler.js';
import {
  isStandalone,
  materializePlaygroundUi,
  materializeServeAssets,
  materializeStudioUi,
  embeddedWorkerVersion,
} from '../serve/standalone-assets.js';
import { loadProjectDatabaseRules, loadProjectRules, watchProjectRules } from '../serve/rules.js';
import { createEventHub, createPyricNamespace, injectServeTags, type InitPayload } from '../serve/namespace.js';
import { createStateStore, STATE_FILE_VERSION, type PyricStateFile } from '../serve/state-store.js';
import { diskProjectStore, diskWorkspace } from '../serve/studio/index.js';
import { createCaptureStore } from '../serve/capture-store.js';
import { consoleServeLogger, startStaticServer, stderrServeLogger, type ServeHandle } from '../serve/server.js';
import { createBridgeMount } from '../serve/bridge-mount.js';
import { openBrowser, shouldAutoOpen } from '../serve/open-browser.js';
import {
  buildChildEnv,
  detectPackageManager,
  readDevScript,
  registerModuleUrl,
  resolveDevChild,
  spawnDevChild,
  waitForSandboxPeer,
  type DevChildHandle,
} from './dev-runner.js';

interface HostingConfig {
  public?: string;
  rewrites?: Array<{ source?: string; destination?: string }>;
}

/** Extract the single hosting config `pyric dev` v1 supports. Arrays
 *  (multi-site) take the first entry with a warning — multi-site is out of
 *  scope (plan section 6). */
export function extractHosting(config: FirebaseJson | null): HostingConfig | null {
  const h = config?.hosting;
  if (!h || typeof h !== 'object') return null;
  if (Array.isArray(h)) return (h[0] as HostingConfig) ?? null;
  return h as HostingConfig;
}

/** firebase.json's SPA idiom: a `**` rewrite to /index.html. */
export function wantsSpaRewrite(hosting: HostingConfig | null): boolean {
  return (hosting?.rewrites ?? []).some(
    (r) => r.source === '**' && r.destination === '/index.html',
  );
}


export interface ServeRuntime {
  handle: ServeHandle;
  publicDir: string;
  payload: () => InitPayload;
  /** HTTP MCP endpoint when `--bridge` is on; null otherwise. */
  mcpUrl: string | null;
  /** The Studio app URL (`/__pyric/ui/`) when `--ui` is on and the build is
   *  present; null otherwise. */
  uiUrl: string | null;
  /** Persistence summary (null when `--persist` is off). */
  persist: { restoredDocs: number; restoredUsers: number } | null;
}

/** The `--json` stdout contract — one line, keep stable; agents parse this.
 *  Readiness probe: GET {url}/__pyric/init.json → 200 (body carries the live
 *  rules hash). */
export function serveJsonLine(runtime: ServeRuntime): string {
  return JSON.stringify({
    url: runtime.handle.url,
    port: runtime.handle.port,
    uiUrl: runtime.uiUrl,
    mcpUrl: runtime.mcpUrl,
    rulesHash: runtime.payload().rulesHash,
    databaseRulesHash: runtime.payload().databaseRulesHash ?? null,
    persist: runtime.persist !== null,
    restoredDocs: runtime.persist?.restoredDocs ?? 0,
    restoredUsers: runtime.persist?.restoredUsers ?? 0,
  });
}

/**
 * Programmatic entry — everything but flag parsing and process lifecycle.
 * Exported so integration tests drive a real server without a subprocess.
 */
export async function startServe(opts: {
  cwd: string;
  port?: number;
  host?: string;
  noCache?: boolean;
  /** Override the bundle cache root (tests). */
  cacheRoot?: string;
  /** Mount the MCP bridge on the serve origin (`--bridge`). */
  bridge?: boolean;
  /** Project label for the bridge health/audit surfaces. */
  project?: string;
  /** Disable the bridge audit writer (tests). */
  disableAuditLog?: boolean;
  /** Path to a seed JSON file (path → fields map), applied at page init. */
  seed?: string;
  /** Watch firestore.rules and hot-reload over SSE. Default true when a
   *  rules file exists. */
  watch?: boolean;
  /** Persist sandbox state to `.pyric/state/state.json` (flow doc section 3c).
   *  Ephemeral remains the default. */
  persist?: boolean;
  /** With `--persist`: discard any existing state file and re-seed from
   *  scratch (the escape hatch from "state wins after the first run"). */
  fresh?: boolean;
  /** Extra hostnames allowed past the DNS-rebinding guard. */
  allowedHosts?: string[];
  /** Write the session capture to `.pyric/last-session.json` so `pyric verify`
   *  can replay it. Default true; pass false (via `--no-capture`) to suppress.
   *  This is independent of `--persist` — capture records the live session
   *  fixture for the verify loop regardless of whether state is persisted. */
  capture?: boolean;
  /** Mount the Pyric Studio storage routes (`--ui`): `/__pyric/workspace`
   *  (the served project's file tree) + `/__pyric/projects` (single-project
   *  store over `cwd`). The Studio app's `local` mode talks to these. */
  ui?: boolean;
  logger?: Parameters<typeof startStaticServer>[0]['logger'];
}): Promise<ServeRuntime> {
  const logger = opts.logger ?? consoleServeLogger();

  // firebase.json is optional for serving (firebase-serve parity: warn, then
  // serve the directory anyway).
  let config: FirebaseJson | null = null;
  try {
    config = await readFirebaseJson(opts.cwd);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes('no firebase.json')) throw e;
    logger.note('  ⚠ no firebase.json found — serving the current directory without hosting config');
  }

  const hosting = extractHosting(config);
  if (Array.isArray(config?.hosting) && (config.hosting as unknown[]).length > 1) {
    logger.note('  ⚠ multiple hosting sites configured — pyric dev v1 serves the first entry only');
  }
  const publicDir = resolve(opts.cwd, hosting?.public ?? '.');
  if (!existsSync(publicDir)) {
    // A missing `dist/` almost always means "no build yet" — the web scaffold's
    // hosting.public is the Vite output. Point at the dev/build loop instead of
    // a bare path error (serve previews a build; `vite dev` is the dev server).
    const looksLikeBuildOutput = /(^|[\\/])(dist|build|out)$/.test(publicDir);
    const hint = looksLikeBuildOutput
      ? `\n  No build yet? Run \`bun run dev\` for the live sandbox dev server, ` +
        `or \`bun run build\` then \`pyric dev\` to preview the production build.`
      : '';
    throw new Error(`pyric dev: hosting.public directory does not exist: ${publicDir}${hint}`);
  }

  // Rules: fail fast on broken rules; serve rule-less only when genuinely absent.
  // Held in a mutable box — the watcher swaps it and the payload producer
  // always serves the live version.
  const loaded = await loadProjectRules(opts.cwd, config);
  const loadedDatabase = await loadProjectDatabaseRules(opts.cwd, config);
  const live = {
    rules: loaded.rules,
    rulesHash: loaded.rulesHash,
    databaseRules: loadedDatabase.rules,
    databaseRulesHash: loadedDatabase.rulesHash,
    databaseUrl: loadedDatabase.databaseUrl,
  };

  // --capture (default on): the capture store writes .pyric/last-session.json
  // whenever the page pushes its session fixture via POST /__pyric/capture.
  // pyric verify (no-arg) reads that file. Independent of --persist — capture
  // records for the verify loop, persist is for cross-reload durability.
  const capture = (opts.capture ?? true) ? createCaptureStore(opts.cwd) : null;

  // --persist: the state store IS the durable sandbox (section 3c). Load eagerly so
  // a corrupt/mismatched file fails the start (inspect-or-delete message)
  // instead of silently serving ephemeral.
  const state = opts.persist ? createStateStore(opts.cwd) : null;
  // --fresh: the escape hatch from "state wins after the first run" — drop
  // the existing state (+ its backup) so this run re-seeds from scratch.
  if (state && opts.fresh) {
    for (const p of [state.path, state.backupPath]) if (existsSync(p)) rmSync(p);
    logger.note('  ⓘ --fresh: discarded the existing state file; re-seeding');
  }
  let persistedEnvelope = state?.load() ?? null;

  // --seed accepts BOTH shapes: a bare path→fields map, or a PyricStateFile
  // envelope (detected by its `version` key — what `pyric snapshot` emits).
  let seed: Record<string, Record<string, unknown>> | null = null;
  /** Ephemeral fixture restore: the controller blob from a state-file seed,
   *  restored in-page through the persistence deserializer (wrapper
   *  re-hydration) via a read-only backend. */
  let seedState: unknown | null = null;
  let seedUsers: Record<string, unknown>[] | null = null;
  let seedLabel = '';
  if (opts.seed) {
    const seedPath = resolve(opts.cwd, opts.seed);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(seedPath, 'utf8'));
    } catch (e) {
      throw new Error(`pyric dev: failed to read --seed ${seedPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`pyric dev: --seed must be a JSON object of "collection/doc" → fields, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.version === STATE_FILE_VERSION && ('firestore' in obj || 'auth' in obj)) {
      const fixture = obj as unknown as PyricStateFile;
      const docCount = Object.keys(
        ((fixture.firestore as { firestore?: Record<string, unknown> } | null)?.firestore) ?? {},
      ).length;
      const userCount = fixture.auth?.users?.length ?? 0;
      seedLabel = `${docCount} doc(s) + ${userCount} user(s) from state fixture`;
      if (state && !state.exists()) {
        // Persist first run seeded from a fixture: prime the store, then the
        // normal persist path restores it like any lived state.
        if (fixture.firestore != null) state.writeSection('firestore', fixture.firestore);
        if (fixture.auth != null) state.writeSection('auth', fixture.auth);
        persistedEnvelope = state.load();
      } else if (!state) {
        seedState = fixture.firestore ?? null;
        seedUsers = (fixture.auth?.users as Record<string, unknown>[] | undefined) ?? null;
      }
      // persist + existing state: the lived state wins; the fixture is inert.
    } else {
      seed = parsed as Record<string, Record<string, unknown>>;
      seedLabel = `${Object.keys(seed).length} document(s)`;
    }
  }

  // SDK bundles (cached per pyric version + entry hash). In a standalone
  // binary the runtime esbuild bundler is unavailable, so the deterministic
  // bundles were built at compile time and embedded; materialize them to a
  // temp dir instead (see serve/standalone-assets.ts). Everything downstream
  // (the /__pyric/sdk/* namespace, worker route) reads from `bundle.outDir`
  // and is identical either way.
  const t0 = performance.now();
  let bundle: { outDir: string; cached: boolean };
  // The worker content hash: stamped into the page (`<meta name="pyric-worker-v">`)
  // so the page can WARN when a still-running worker is older than the served
  // bundle. The worker NAME is stable (`pyric-shared-worker`) — all tabs share
  // one backend — so a SharedWorker (which can't hot-update) is detected as
  // stale, not auto-replaced; the user closes all tabs to load the new worker.
  let workerVersion: string;
  if (isStandalone()) {
    bundle = await materializeServeAssets();
    workerVersion = embeddedWorkerVersion();
  } else {
    bundle = await bundleSdk({ entries: defaultSdkEntries(), noCache: opts.noCache, cacheRoot: opts.cacheRoot });
    // The SharedWorker host (Phase 3c): bundled into the SAME sdk dir so the
    // existing /__pyric/sdk/worker.js route serves it. The page's entry
    // adapters feature-detect SharedWorker → this worker; unsupported browsers
    // fall back to the in-page sandbox. Built alongside the SDK so a warm
    // start skips both.
    await bundleWorker({ outDir: bundle.outDir, noCache: opts.noCache });
    workerVersion = workerSourceHash();
  }
  const bundleMs = Math.round(performance.now() - t0);

  const mount = opts.bridge
    ? createBridgeMount({
        project: opts.project,
        disableAuditLog: opts.disableAuditLog,
        upgradeGuard: { boundHost: opts.host ?? 'localhost', allowedHosts: opts.allowedHosts },
      })
    : null;

  // bridgeUrl needs the BOUND port; resolved after listen via this box.
  const origin = { host: opts.host ?? 'localhost', port: 0 };
  const payload = (): InitPayload => ({
    rules: live.rules,
    rulesHash: live.rulesHash,
    databaseRules: live.databaseRules,
    databaseRulesHash: live.databaseRulesHash,
    databaseUrl: live.databaseUrl,
    bridgeUrl: mount && origin.port > 0 ? mount.wsUrl(origin) : null,
    // Precedence: once a state file exists, the lived state is the truth —
    // --seed applies only on the first (state-less) run.
    seed: state?.exists() ? null : seed,
    seedState,
    persist: Boolean(state),
    capture: Boolean(capture),
    authUsers: state
      ? ((state.readSection('auth') as { users?: Record<string, unknown>[] } | null)?.users ?? null)
      : seedUsers,
  });

  const events = createEventHub();
  // --ui (Pyric Studio): serve the disk-backed workspace + project routes.
  // Single-project mode: the served `cwd` IS the one project's file tree; the
  // project store roots at `.pyric/projects` (multi-project ready) but the
  // current served tree is also reachable directly via /__pyric/workspace.
  const studio = opts.ui
    ? {
        workspace: diskWorkspace(opts.cwd),
        projects: diskProjectStore(join(opts.cwd, '.pyric', 'projects')),
      }
    : undefined;
  // --ui also serves the BUILT Studio app under /__pyric/ui/. The dir is
  // resolved by file path (never imported), so a missing build is a clear
  // warning rather than a crash; the data routes still mount.
  let studioUiDir: string | undefined;
  let playgroundUiDir: string | undefined;
  if (opts.ui) {
    // Standalone: the Studio app was embedded at compile time; materialize it.
    const dir = isStandalone() ? await materializeStudioUi() : resolveStudioUiDir();
    const playgroundDir = isStandalone() ? await materializePlaygroundUi() : resolvePlaygroundUiDir();
    if (dir) {
      studioUiDir = dir;
    } else {
      logger.note(
        '  ⚠ --ui: built Studio app not found (run the full build first). ' +
          'The data routes are mounted, but /__pyric/ui/ will 404.',
      );
    }
    if (playgroundDir) {
      playgroundUiDir = playgroundDir;
    } else {
      logger.note(
        '  ⚠ --ui: built Playground app not found (run the full build first). ' +
          'The Studio data routes are mounted, but /__pyric/playground/ will 404.',
      );
    }
  }
  const sdkNamespace = createPyricNamespace({
    sdkDir: bundle.outDir,
    initPayload: payload,
    events,
    state: state ?? undefined,
    capture: capture ?? undefined,
    studio,
    studioUiDir,
    playgroundUiDir,
  });
  const handle = await startStaticServer({
    publicDir,
    port: opts.port ?? 3473,
    host: opts.host ?? 'localhost',
    spaRewrite: wantsSpaRewrite(hosting),
    namespaceHandler: mount
      ? async (req, res, url) => (await mount.handler(req, res, url)) || sdkNamespace(req, res, url)
      : sdkNamespace,
    // Never force in-page: serve always serves the worker, and the bridge peer
    // routes agent tool-calls THROUGH the worker (see connectBridgePeer), so app
    // + Studio + agent share the one sandbox even under --bridge.
    transformHtml: (html) => injectServeTags(html, undefined, workerVersion),
    allowedHosts: opts.allowedHosts,
    logger,
  });
  origin.port = handle.port;
  // Attach the WS upgrade to EVERY bound server so the sandbox peer connects on
  // whichever loopback family the page resolved (localhost binds both now).
  if (mount) for (const s of handle.servers) mount.attachUpgrade(s);
  const uiUrl = studioUiDir ? `${handle.url}/__pyric/ui/` : null;

  // Discovery pointer (the Claude Code plugin's stdio proxy reads this so it
  // never has to guess the dynamic port). Written next to the project state
  // when --bridge is on; removed on clean shutdown. plans/pyric-plugin.
  if (mount) {
    const pointer = join(opts.cwd, '.pyric', 'serve.json');
    try {
      mkdirSync(dirname(pointer), { recursive: true });
      writeFileSync(
        pointer,
        JSON.stringify(
          { url: handle.url, mcpUrl: mount.mcpUrl(origin), port: handle.port, pid: process.pid, instanceId: mount.instanceId, project: opts.project ?? 'sandbox' },
          null,
          2,
        ) + '\n',
      );
      handle.server.once('close', () => { try { rmSync(pointer); } catch { /* gone already */ } });
    } catch { /* best-effort: discovery falls back to a port scan */ }
  }

  // Hot-reload: watch the rules file, swap the live ruleset, broadcast.
  const watching = (opts.watch ?? true) && loaded.sourcePath !== null;
  if (watching) {
    const watcher = watchProjectRules(
      loaded.sourcePath!,
      (next) => {
        live.rules = next.rules;
        live.rulesHash = next.rulesHash;
        events.broadcast('rules-changed', next);
        logger.note(`  ↻ rules reloaded (hash ${next.rulesHash}) → ${events.clientCount()} page(s)`);
      },
      (message) => logger.note(`  ⚠ rules NOT reloaded (last-good stays live): ${message}`),
    );
    handle.server.once('close', () => watcher.close());
  }

  logger.info(`=== Serving from '${opts.cwd}'...`);
  logger.info('');
  logger.info(`✔ hosting  Serving files from: ${hosting?.public ?? '.'}`);
  logger.info(`✔ hosting  Local server: ${handle.url}`);
  logger.info(
    isStandalone()
      ? `✔ sandbox  pyric SDK bundles ready (embedded)`
      : bundle.cached
        ? `✔ sandbox  pyric SDK bundles ready (cache)`
        : `✔ sandbox  pyric SDK bundles built in ${bundleMs}ms`,
  );
  logger.info(
    loaded.rules
      ? `✔ rules    ${loaded.sourcePath} → deployed to the in-page sandbox (hash ${loaded.rulesHash})`
      : `• rules    no firestore.rules — sandbox runs with default rules`,
  );
  logger.info(
    loadedDatabase.rules
      ? `✔ rules    ${loadedDatabase.sourcePath} → deployed to the RTDB sandbox (hash ${loadedDatabase.rulesHash})`
      : `• rules    no database.rules — RTDB sandbox runs with default rules`,
  );
  if (uiUrl) {
    logger.info(`✔ studio   Pyric Studio: ${uiUrl}`);
  }
  if (mount) {
    logger.info(`✔ bridge   MCP endpoint: ${mount.mcpUrl(origin)} (sandbox peers over ws at /__pyric/sandbox)`);
  }
  let persistSummary: ServeRuntime['persist'] = null;
  if (state) {
    const fsDocs = persistedEnvelope?.firestore
      ? Object.keys((persistedEnvelope.firestore as { firestore?: Record<string, unknown> }).firestore ?? {}).length
      : 0;
    const users = (persistedEnvelope?.auth as { users?: unknown[] } | null)?.users?.length ?? 0;
    persistSummary = { restoredDocs: fsDocs, restoredUsers: users };
    logger.info(
      persistedEnvelope
        ? `✔ persist  ${state.path} (${fsDocs} doc(s), ${users} user(s) restored; --seed skipped)`
        : `✔ persist  new state file at ${state.path} (first run — seed applies)`,
    );
    if (existsSync(state.backupPath)) {
      logger.note(
        `  ⓘ a recovery backup exists at ${state.backupPath} (prior non-empty state was ` +
          'replaced by an empty one — e.g. a reset). Restore: mv it back over state.json.',
      );
    }
  }
  // (A fixture that primed the persist store is reported by the persist
  // line; a fixture ignored because lived state exists is intentionally
  // silent about staging.)
  if ((seed && !state?.exists()) || seedState || seedUsers) {
    logger.info(`✔ seed     ${seedLabel} staged for page init`);
  }
  if (capture) {
    logger.info(`✔ capture  session → ${capture.path} (run \`pyric verify\` to replay it)`);
  }
  if (watching) logger.info(`✔ watch    hot-reloading ${loaded.sourcePath} over /__pyric/events`);
  // Browser-honesty: the sandbox is browser-resident — firestore/auth and
  // persistence run IN the served page. With no page open, data ops silently
  // no-op. This warning (paired with auto-open in runServe) is the fix for the
  // "I ran serve and nothing happened" surprise. Always printed.
  logger.note('');
  logger.note('  ⚠ the pyric sandbox runs IN the served page — keep the browser tab open.');
  logger.note('    Firestore/auth data and persistence stop when no page is open.');
  return { handle, publicDir, payload, uiUrl, mcpUrl: mount ? mount.mcpUrl(origin) : null, persist: persistSummary };
}

/**
 * `--ui` implies `--bridge` (hybrid-MCP plan Phase 3): a Studio user almost
 * always wants MCP too, and the two independent flags were a real setup footgun.
 * Pure + exported for unit coverage.
 */
export function bridgeEnabledFromFlags(flags: { get(key: string): unknown }): boolean {
  return Boolean(flags.get('bridge')) || Boolean(flags.get('ui'));
}

/**
 * A dev child also implies the bridge: the runner injects
 * `PYRIC_SANDBOX=remote:<url>` into the child, whose remote client dials the
 * `/__pyric/sandbox` WS — without the bridge mount that upgrade 404s and
 * plain `pyric dev -- <cmd>` (or a detected dev script) breaks its own
 * child. Pure + exported for unit coverage.
 */
export function bridgeEnabledFor(
  flags: { get(key: string): unknown },
  childPlan: unknown,
): boolean {
  return bridgeEnabledFromFlags(flags) || childPlan != null;
}

/** CLI entry. Resolves on SIGINT/SIGTERM after a clean stop. */
export async function runServe(parsed: ParsedArgs): Promise<number> {
  const flagPort = parsed.flags.get('port');
  const port = typeof flagPort === 'string' ? Number(flagPort) : 3473;
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    process.stderr.write(`pyric: invalid --port '${flagPort}'.\n`);
    return 1;
  }
  const flagHost = parsed.flags.get('host');
  const host = typeof flagHost === 'string' ? flagHost : 'localhost';

  const only = parsed.flags.get('only');
  if (typeof only === 'string' && only !== 'hosting') {
    process.stderr.write(
      `pyric: --only '${only}' is not supported — pyric dev v1 serves hosting (with the in-page sandbox standing in for firestore/auth).\n`,
    );
    return 1;
  }

  const json = Boolean(parsed.flags.get('json'));

  const uiOn = Boolean(parsed.flags.get('ui'));

  // Resolve the child plan BEFORE the server starts: a planned child implies
  // the bridge (see bridgeEnabledFor) — the child's injected PYRIC_SANDBOX
  // is useless without the /__pyric/sandbox WS mount.
  const cwd = process.cwd();
  const plan = resolveDevChild({
    passthrough: parsed.passthrough ?? [],
    noRun: Boolean(parsed.flags.get('no-run')),
    json,
    devScript: readDevScript(cwd),
    packageManager: detectPackageManager(cwd),
  });
  const bridgeOn = bridgeEnabledFor(parsed.flags, plan);

  let runtime: ServeRuntime;
  try {
    runtime = await startServe({
      cwd: process.cwd(),
      port,
      host,
      logger: json ? stderrServeLogger() : undefined,
      noCache: Boolean(parsed.flags.get('no-cache')),
      bridge: bridgeOn,
      seed: typeof parsed.flags.get('seed') === 'string' ? (parsed.flags.get('seed') as string) : undefined,
      watch: parsed.flags.get('no-watch') ? false : undefined,
      persist: Boolean(parsed.flags.get('persist')),
      fresh: Boolean(parsed.flags.get('fresh')),
      // --ui mounts the Pyric Studio storage routes (workspace + projects).
      ui: uiOn,
      // --no-capture disables the default-on session capture. The pattern
      // mirrors --no-open: default is true, one flag inverts it.
      capture: parsed.flags.get('no-capture') ? false : true,
      allowedHosts:
        typeof parsed.flags.get('allowed-host') === 'string'
          ? (parsed.flags.get('allowed-host') as string).split(',').map((h) => h.trim()).filter(Boolean)
          : undefined,
      project: typeof parsed.flags.get('project') === 'string' ? (parsed.flags.get('project') as string) : process.env.PYRIC_PROJECT,
    });
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  // The agent contract: with --json, stdout carries exactly this one line
  // (the banner went to stderr). Readiness probe: GET /__pyric/init.json.
  if (json) process.stdout.write(serveJsonLine(runtime) + '\n');

  // Footgun guard (hybrid-MCP plan Phase 3): plain `dev` mounts no MCP bridge,
  // so a `pyric mcp-proxy` in an editor cannot attach. Nudge toward --bridge.
  if (!bridgeOn && !json) {
    process.stderr.write(
      '  tip  MCP? re-run with --bridge so an editor (Cursor / Claude / Antigravity) can attach via `pyric mcp-proxy`.\n',
    );
  }

  // Auto-open the served page (best-effort) so the browser-resident sandbox is
  // actually running. Suppressed in non-interactive paths (--json, --no-open,
  // no TTY, CI) — see shouldAutoOpen. A failed open never fails serve.
  const opened = shouldAutoOpen({
    json,
    noOpen: Boolean(parsed.flags.get('no-open')),
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  });
  if (opened) {
    // With --ui, open Studio directly; the served page is still available.
    void openBrowser(runtime.uiUrl ?? runtime.handle.url);
  }

  // The child runner ("one command, not two"): run the user's own dev
  // command with the sandbox environment injected. Precedence: `-- <cmd>`
  // wins; else the package.json dev script; else host-only. --no-run forces
  // host-only; --json defaults to host-only (explicit `--` still wins).
  // (`plan` was resolved above so it could imply the bridge mount.)
  let devChild: DevChildHandle | null = null;
  if (plan) {
    const info = json ? process.stderr : process.stdout;
    // First-run race guard: we just opened the tab ourselves, so wait
    // (bounded) for it to register as the sandbox peer before the child's
    // first op can lose the race and die on the no-tab fail-fast. Skipped
    // when nothing was opened (CI/--no-open/--json): no tab is coming, and
    // stalling would only delay the honest failure.
    if (opened) {
      info.write('• run      waiting for the browser tab to connect the sandbox…\n');
      const connected = await waitForSandboxPeer(runtime.handle.url);
      if (!connected) {
        info.write(
          `  ⚠ no browser tab connected after 30s — starting your command anyway; sandbox ops will fail until ${runtime.handle.url} is open.\n`,
        );
      }
    }
    info.write(
      `✔ run      \`${plan.label}\` — firebase-admin/firebase imports are routed to the sandbox at ${runtime.handle.url}\n`,
    );
    devChild = spawnDevChild(plan, {
      cwd,
      json,
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
      }),
    });
  }

  return await new Promise<number>((resolveExit) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      void runtime.handle.stop().then(
        () => resolveExit(code),
        () => resolveExit(code),
      );
    };
    const shutdown = (signal: NodeJS.Signals): void => {
      (json ? process.stderr : process.stdout).write('\nShutting down...\n');
      if (devChild && devChild.child.exitCode === null) {
        // Forward the signal; the child's exit (below) closes the host.
        // (The terminal delivers Ctrl-C to the whole group too — the
        // forward makes non-TTY / programmatic signals behave the same.)
        devChild.signal(signal);
      } else {
        finish(0);
      }
    };
    // Child exits → close the host and propagate its code (Ctrl-C → 0).
    if (devChild) void devChild.exited.then((code) => finish(code));
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });
}
