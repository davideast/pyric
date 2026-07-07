#!/usr/bin/env node
/**
 * `pyric` CLI — front door to the bridge + project tooling.
 *
 * Subcommands:
 *   pyric bridge [--mode sandbox|prod] [--port N] [--project ID] …
 *   pyric serve [--port N] [--host H] [--no-cache] [--bridge] [--ui] [--seed FILE] [--no-watch] [--no-open] [--no-capture] [--json] [--persist] [--fresh]
 *   pyric init [dir] [--template web|node] [--name N] [--force] [--json]
 *   pyric vendor [dir] [--json]
 *   pyric snapshot [--out FILE] [--port N] [--force] [--json] [--include-passwords]
 *   pyric mcp
 *   pyric deploy <rules|indexes|database|hosting|functions>
 *   pyric hosting:channel:deploy <channelId> [--expires <ttl>]
 *   pyric rules:lint <path>
 *   pyric rules:validate <path>
 *   pyric rules:simulate [--stdin]
 *   pyric database:rules:lint <path>
 *   pyric database:rules:validate <path>
 *   pyric database:rules:simulate [--stdin]
 *   pyric auth:configure-provider <provider> <true|false>
 *   pyric auth:manage-domains <add|remove|list> [domain]
 *   pyric firestore:discover [collection]
 *   pyric login [--ci]
 *   pyric logout
 *   pyric whoami
 *   pyric --help
 *   pyric --version
 *
 * Env vars:
 *   PYRIC_MODE                       — 'sandbox' (default) or 'prod' (bridge)
 *   PYRIC_PORT                       — bridge port (default 5174)
 *   PYRIC_PROJECT                    — project id (sandbox: any; prod: Firebase project id)
 *   PYRIC_VERBOSE                    — set to 1 for per-tool-call logging
 *   FIREBASE_SA_BASE64               — base64-encoded service-account JSON (deploy / auth / discover)
 *   GOOGLE_APPLICATION_CREDENTIALS   — path to service-account JSON (deploy / auth / discover)
 *   FIREBASE_DATABASE_URL            — Realtime Database URL for deploy database
 *   PYRIC_OAUTH_CLIENT_ID            — Google "Desktop app" OAuth client id (pyric login)
 *   PYRIC_OAUTH_CLIENT_SECRET        — its client secret (pyric login; required by Google)
 *   PYRIC_REFRESH_TOKEN              — CI refresh token from `pyric login --ci`
 *
 * Exit codes:
 *   0  success
 *   1  usage error
 *   2  runtime error
 */

import { startServer, type BridgeMode } from 'pyric-tools/bridge';
import { parseArgs, type ParsedArgs } from './parse-args.js';
import { runDeploy, runHostingChannelDeploy } from './deploy.js';
import { runLoginCommand, runLogoutCommand, runWhoamiCommand } from './login.js';
import { runRulesLint, runRulesValidate, runRulesSimulate } from './rules.js';
import {
  runDatabaseRulesLint,
  runDatabaseRulesValidate,
  runDatabaseRulesSimulate,
} from './database-rules.js';
import { runAuthConfigureProvider, runAuthManageDomains } from './auth.js';
import { runFirestoreDiscover } from './discover.js';
import { runInit, runVendor } from './init.js';
import { runServe } from './serve.js';
import { runSnapshot } from './snapshot.js';
import { runVerify } from './verify.js';
import { runMcpProxy } from './mcp-proxy.js';
import { pyricVersion } from '../serve/standalone-assets.js';

// The standalone binary bakes the real `pyric` version onto the embedded-assets
// global; the npm bin has no such global and falls back to '0.0.0'.
const VERSION = pyricVersion();

function printUsage(): void {
  process.stdout.write(`pyric ${VERSION}
Firebase for agents — bridge an in-browser pyric sandbox (or a real Firebase
project) to external MCP clients (Claude Code, Cursor, ...).

USAGE
  pyric bridge [flags]
  pyric serve [flags]
  pyric init [dir] [--template=web|node]
  pyric snapshot [--out=FILE]
  pyric verify [fixture|dir] [--service firestore|rtdb] [--rules service=path]
  pyric deploy <rules|indexes|database|hosting|functions>
  pyric hosting:channel:deploy <channelId> [--expires <ttl>]
  pyric rules:lint <path>
  pyric rules:validate <path>
  pyric rules:simulate [--stdin]
  pyric database:rules:lint <path>
  pyric database:rules:validate <path>
  pyric database:rules:simulate [--stdin]
  pyric auth:configure-provider <anonymous|email|phone|google> <true|false>
  pyric auth:manage-domains <add|remove|list> [domain]
  pyric firestore:discover [collection]
  pyric login [--ci]
  pyric logout
  pyric whoami
  pyric --help
  pyric --version

COMMANDS
  bridge                     Start the HTTP+WebSocket bridge external MCP clients point at.
  serve                      Serve the app locally with the pyric sandbox standing in for
                             Firebase — unmodified firebase/* imports hit an in-page sandbox
                             with your firestore.rules deployed.
  init [dir]                 Scaffold a pyric project. --template=web (default; canonical
                             firebase/* app served by \`pyric serve\`) or node (script-style).
                             --name=NAME --force (overwrite scaffold files) --json (machine
                             output on stdout). Never prompts; rerunning is safe.
  vendor [dir]               Retrofit: vendor pyric + pyric-tools into an existing
                             project (lay file: tarballs into vendor/ + merge their
                             deps into package.json). Scaffolds nothing. Then run
                             bun install. Standalone binary only.
  mcp                        Stdio MCP server for editors (Cursor / Claude /
                             Antigravity). Hosts a headless in-process sandbox,
                             or attaches to a running \`pyric serve --bridge\`
                             (found via .pyric/serve.json) for shared-live Studio.
  snapshot [--out=FILE]      Promote lived sandbox state (live serve --persist, else
                             .pyric/state/state.json) to a committable fixture that
                             \`pyric serve --seed FILE\` re-serves. Passwords are redacted
                             by default (--include-passwords keeps them). --port, --force, --json.
  verify [fixture|dir]       Replay a captured sandbox session against candidate rules
                             for the Firestore/RTDB services present in the fixture.
                             No arg replays the latest \`pyric serve\` capture
                             (.pyric/last-session.json). --service filters services.
                             --rules service=path overrides firebase.json resolution
                             (repeat for mixed captures). --json. Exit 1 on divergence.
  deploy [target]            Deploy rules / indexes / database / hosting / functions.
                             hosting: deploys the firebase.json hosting block
                             (rewrites/redirects/headers/cleanUrls/trailingSlash/
                             appAssociation/i18n + ignore globs). --only
                             hosting:<siteOrTarget> picks an entry (default:
                             first); --project accepts a .firebaserc alias.
                             --channel <id|auto> releases to a preview channel
                             instead of live (auto = current git branch,
                             sanitized); --channel-ttl/--expires <30m|12h|7d>
                             caps its lifetime (default 7d, max 30d).
                             Agent I/O (hosting): --schema prints the deploy
                             tool's JSON Schema; --json '<payload>' validates
                             against it and feeds the tool directly (bypasses
                             firebase.json); bare --json = machine output for
                             a normal deploy (results to stdout, errors to
                             stderr, as JSON).
                             database: deploys firebase.json database.rules.
                             URL precedence: --database-url,
                             FIREBASE_DATABASE_URL, firebase.json
                             database.url, then default instance discovery.
  hosting:channel:deploy     Mirror of \`deploy hosting --channel <channelId>\`
                             (firebase-tools spelling) — identical behavior.
  rules:lint                 Run firestore-rules linter against a file.
  rules:validate             Validate firestore-rules structure against a file.
  rules:simulate             Local rules simulator (smoke-test or --stdin scripted).
  database:rules:lint        Run Realtime Database rules JSON expression linter.
  database:rules:validate    Validate Realtime Database rules JSON expressions.
  database:rules:simulate    Local RTDB rules simulator (smoke-test or --stdin scripted).
  auth:configure-provider    Identity Toolkit: enable/disable an auth provider.
  auth:manage-domains        Identity Toolkit: add/remove/list authorized domains.
  firestore:discover         Crawl a Firestore to infer schema.
  login [--ci]               Google sign-in for deploy / auth / discover (loopback
                             OAuth + PKCE). Stores a refresh token at
                             ~/.pyric/credentials.json. --ci prints the token to
                             stdout to set as PYRIC_REFRESH_TOKEN in CI. Requires
                             PYRIC_OAUTH_CLIENT_ID + PYRIC_OAUTH_CLIENT_SECRET.
  logout                     Clear the stored credential (~/.pyric/credentials.json).
  whoami                     Print the signed-in account + the scopes Google granted.

CORE FLAGS (serve)
  --port             Port to serve on. Default 5000 (scans forward when taken —
                     macOS AirPlay commonly holds 5000).
  --host             Host to bind. Default localhost.
  --no-cache         Rebuild the served pyric SDK bundles (skip ~/.pyric/serve-cache).
  --only hosting     Accepted for firebase-serve parity (hosting is all v1 serves).
  --bridge           Also mount the MCP bridge on the serve origin — agents point
                     at http://<host>:<port>/__pyric/mcp and drive the sandbox
                     living in the served page. --project labels health/audit.
  --ui               Also serve the Pyric Studio app at <url>/__pyric/ui/ (and
                     mount its disk-backed workspace + project data routes).
                     Auto-opens Studio instead of the served page. Needs a full
                     build so the app assets are present.
  --seed FILE        JSON map of "collection/doc" → fields, loaded admin-style.
                     Also accepts a pyric state file (from \`pyric snapshot\`,
                     detected by its version key) — seeds docs + auth users.
                     into the page sandbox before app code runs.
  --no-watch         Disable firestore.rules hot-reload (on by default).
  --no-open          Don't auto-open the browser. serve opens the served page
                     by default (the sandbox is browser-resident); auto-open
                     is already suppressed under --json, no TTY, and CI.
  --no-capture       Don't write the session capture. serve writes
                     .pyric/last-session.json by default so \`pyric verify\`
                     can replay your session; --no-capture disables it.
  --allowed-host H   Allow an extra Host header past the DNS-rebinding guard
                     (comma-separated; localhost/127.0.0.1 always allowed).
  --persist          Persist sandbox state (docs + auth users) to
                     .pyric/state/state.json — survives reloads and serve
                     restarts. Once a state file exists it wins; --seed
                     applies only on the first (state-less) run. Ephemeral
                     is the default.
  --fresh            With --persist: discard the existing state file and
                     re-seed from scratch (escape hatch when you've edited
                     seed.json).
  --json             One machine-readable line on stdout ({url, port, mcpUrl,
                     rulesHash, persist, restoredDocs, restoredUsers}); the
                     banner moves to stderr. Readiness probe:
                     GET <url>/__pyric/init.json → 200 (live rules hash).

CORE FLAGS (bridge)
  --mode             'sandbox' (default) or 'prod'. Prod mode requires Firebase
                     credentials (GOOGLE_APPLICATION_CREDENTIALS / PYRIC_SA_PATH)
                     AND interactive terminal confirmation (or --non-interactive).
  --port             Port to bind on 127.0.0.1. Default 5174. Env: PYRIC_PORT.
  --project          Project id surfaced in /health + audit log. Required for
                     --mode prod (typically the Firebase project id).
                     Env: PYRIC_PROJECT.

PROD-MODE CONFIRMATION FLAGS
  --auto-approve LIST    Comma-separated tool names that skip confirmation.
  --require-confirm LIST Comma-separated tool names forced to always prompt.
  --require-confirm-all  Force every tool, including reads, to prompt.
  --confirm-timeout MS   Per-prompt timeout. Default 45000.
  --non-interactive      Run prod mode without a TTY (CI etc.).

CREDENTIALS
  pyric login uses an OAuth "Desktop app" client (loopback + PKCE) and stores a
  refresh token at ~/.pyric/credentials.json. Configure the client with:
    PYRIC_OAUTH_CLIENT_ID            Google "Desktop app" OAuth client id (required)
    PYRIC_OAUTH_CLIENT_SECRET        its client secret (required — Google's token
                                     exchange needs it even with PKCE)

  deploy / auth / discover resolve a credential in this precedence order:
    1. FIREBASE_SA_BASE64            base64-encoded service-account JSON (CI)
    2. GOOGLE_APPLICATION_CREDENTIALS  path to a service-account JSON file
    3. PYRIC_REFRESH_TOKEN           CI refresh token from \`pyric login --ci\`
    4. ~/.pyric/credentials.json     the \`pyric login\` user (granted scopes only)
    5. ADC                           \`gcloud auth application-default login\` (ambient)
  PYRIC_PROJECT / --project          project id for user/ADC creds (else .firebaserc default)
  FIREBASE_DATABASE_URL              Realtime Database URL for \`pyric deploy database\`
`);
}

function printVersion(): void {
  process.stdout.write(`${VERSION}\n`);
}

function splitCommaList(value: string | boolean | Array<string | boolean> | undefined): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((v): v is string => typeof v === 'string')
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

async function runBridge(parsed: ParsedArgs): Promise<number> {
  const flagMode = parsed.flags.get('mode');
  const mode: BridgeMode =
    (typeof flagMode === 'string' ? flagMode : process.env.PYRIC_MODE ?? 'sandbox') as BridgeMode;
  if (mode !== 'sandbox' && mode !== 'prod') {
    process.stderr.write(`pyric: invalid --mode '${mode}'. Must be 'sandbox' or 'prod'.\n`);
    return 1;
  }

  const flagPort = parsed.flags.get('port');
  const port =
    typeof flagPort === 'string'
      ? Number(flagPort)
      : process.env.PYRIC_PORT
        ? Number(process.env.PYRIC_PORT)
        : undefined;
  if (port !== undefined && (!Number.isFinite(port) || port < 1 || port > 65535)) {
    process.stderr.write(`pyric: invalid --port '${flagPort ?? process.env.PYRIC_PORT}'.\n`);
    return 1;
  }

  const flagProject = parsed.flags.get('project');
  const project =
    typeof flagProject === 'string' ? flagProject : process.env.PYRIC_PROJECT ?? undefined;

  if (mode === 'prod' && !project) {
    process.stderr.write(
      'pyric: --mode prod requires --project <id> (or PYRIC_PROJECT env var).\n',
    );
    return 1;
  }

  if (mode === 'prod') {
    // The CLI doesn't yet wire prodTools (that needs ADC discovery +
    // composeMcpRegistry composition). Without prodTools registered,
    // a CLI-started prod bridge would expose zero tools to MCP
    // clients — confusing UX. Bail with a clear pointer to the
    // programmatic startServer({ prodTools }) path until v1.1
    // wires this end-to-end.
    process.stderr.write(
      'pyric: prod-mode CLI is a v1.1 follow-up — currently requires the caller to wire\n' +
        '       composeMcpRegistry tools via the programmatic startServer({ prodTools })\n' +
        '       API. Use sandbox mode for now, or call startServer directly from a script.\n',
    );
    return 2;
  }

  const autoApproveTools = splitCommaList(parsed.flags.get('auto-approve'));
  const requireConfirmTools = splitCommaList(parsed.flags.get('require-confirm'));
  const requireConfirmAll = parsed.flags.get('require-confirm-all') === true;
  const flagTimeout = parsed.flags.get('confirm-timeout');
  const confirmTimeoutMs =
    typeof flagTimeout === 'string' ? Number(flagTimeout) : undefined;
  if (
    confirmTimeoutMs !== undefined &&
    (!Number.isFinite(confirmTimeoutMs) || confirmTimeoutMs < 1000)
  ) {
    process.stderr.write(
      `pyric: invalid --confirm-timeout '${flagTimeout}'. Must be a number >= 1000 ms.\n`,
    );
    return 1;
  }
  const nonInteractive = parsed.flags.get('non-interactive') === true;

  let handle;
  try {
    handle = await startServer({
      mode,
      port,
      project,
      autoApproveTools,
      requireConfirmTools,
      requireConfirmAll,
      confirmTimeoutMs,
      nonInteractive,
    });
  } catch (err) {
    process.stderr.write(
      `pyric: failed to start bridge: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  // Curated user-facing banner on stdout (lifecycle lines already on stderr).
  // Prod-mode banner branches stay here as dead code today — they'll wake up
  // when CLI prod-mode wiring lands in v1.1. The early `return 2` above
  // currently makes them unreachable; the cast satisfies the narrower.
  const reportedMode = handle.bridge.mode as BridgeMode;
  const prodNotes =
    reportedMode === 'prod'
      ? nonInteractive
        ? `\nPROD MODE (non-interactive):\n` +
          `  Auto-approved tools: ${autoApproveTools.join(', ') || '(none — every call will deny silently)'}\n` +
          `  Everything else denies without prompting.\n`
        : `\n⚠  PROD MODE — confirmation prompts appear in THIS terminal\n` +
          `  Reads auto-approved; writes / deletes / deploys require approval per call.\n` +
          `  Timeout: ${confirmTimeoutMs ?? 45000}ms → defaults to DENY.\n` +
          (autoApproveTools.length > 0
            ? `  Auto-approved (override): ${autoApproveTools.join(', ')}\n`
            : '') +
          (requireConfirmTools.length > 0
            ? `  Force-prompt (override): ${requireConfirmTools.join(', ')}\n`
            : '') +
          (requireConfirmAll ? `  ⚠  Paranoid mode: every tool prompts, even reads.\n` : '')
      : '';

  process.stdout.write(
    `\npyric bridge ${VERSION} ready\n` +
      `  mode:    ${handle.bridge.mode}\n` +
      `  project: ${handle.bridge.project}\n` +
      `  health:  ${handle.url}/health\n` +
      `  mcp:     ${handle.url}/mcp\n` +
      `  sandbox: ${handle.url.replace('http://', 'ws://')}/sandbox\n` +
      (handle.auditLogPath ? `  audit:   ${handle.auditLogPath}\n` : '') +
      prodNotes +
      `\nRegister with Claude Code:\n` +
      `  claude mcp add --transport http pyric ${handle.url}/mcp --scope project\n` +
      `\nBridge will log peer connect/disconnect to stderr. Set PYRIC_VERBOSE=1 for per-tool-call logs.\n` +
      `Press Ctrl-C to stop.\n`,
  );

  // Graceful shutdown. Idempotent because:
  //   1. npx forwards SIGINT to its child AND the terminal sends SIGINT
  //      to the process group, so one Ctrl-C delivers SIGINT TWICE to
  //      this process — without a guard, the handler ran twice and
  //      printed everything twice.
  //   2. An impatient user mashing Ctrl-C expects "now I mean it" to
  //      force-exit, not enqueue more clean-shutdowns.
  let shuttingDown = false;
  const stop = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      process.stderr.write('pyric: force-exiting\n');
      process.exit(130);
    }
    shuttingDown = true;
    process.stdout.write(`\npyric: received ${signal}, stopping bridge...\n`);
    // Hard safety net: clean shutdown is ~instant once sockets are
    // forcibly closed (see handle.stop in standalone.ts). If something
    // hangs anyway — peer pre-handshake, MCP transport in mid-write —
    // don't make the user wait forever.
    const forceExitTimer = setTimeout(() => {
      process.stderr.write('pyric: shutdown taking longer than expected, force-exiting\n');
      process.exit(130);
    }, 2000);
    forceExitTimer.unref();
    try {
      await handle.stop();
    } catch (err) {
      process.stderr.write(
        `pyric: error during shutdown: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    clearTimeout(forceExitTimer);
    process.exit(signal === 'SIGINT' ? 130 : 0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  // Keep the event loop alive.
  return await new Promise<number>(() => {});
}

/**
 * Dispatch a parsed CLI invocation to its subcommand handler.
 * Exported so the test suite can drive the dispatcher directly
 * without spawning a child process. `process.exit` is not called
 * here — the caller (the top-level `main()` below) does that.
 */
export async function dispatch(parsed: ParsedArgs): Promise<number> {
  if (parsed.flags.get('help') || parsed.flags.get('h')) {
    printUsage();
    return 0;
  }
  if (parsed.flags.get('version') || parsed.flags.get('v')) {
    printVersion();
    return 0;
  }

  switch (parsed.subcommand) {
    case null:
    case undefined:
      printUsage();
      return parsed.subcommand === null ? 0 : 1;
    case 'bridge':
      return await runBridge(parsed);
    case 'serve':
      return await runServe(parsed);
    case 'snapshot':
      return await runSnapshot(parsed);
    case 'verify':
      return await runVerify(parsed);
    case 'mcp':
      return await runMcpProxy(parsed);
    case 'init':
      return await runInit(parsed);
    case 'vendor':
      return await runVendor(parsed);
    case 'deploy':
      return await runDeploy(parsed);
    case 'login':
      return await runLoginCommand({ ci: parsed.flags.get('ci') === true });
    case 'logout':
      return await runLogoutCommand();
    case 'whoami':
      return await runWhoamiCommand();
    case 'hosting:channel:deploy':
      return await runHostingChannelDeploy(parsed);
    case 'rules:lint':
      return await runRulesLint(parsed);
    case 'rules:validate':
      return await runRulesValidate(parsed);
    case 'rules:simulate':
      return await runRulesSimulate(parsed);
    case 'database:rules:lint':
      return await runDatabaseRulesLint(parsed);
    case 'database:rules:validate':
      return await runDatabaseRulesValidate(parsed);
    case 'database:rules:simulate':
      return await runDatabaseRulesSimulate(parsed);
    case 'auth:configure-provider':
      return await runAuthConfigureProvider(parsed);
    case 'auth:manage-domains':
      return await runAuthManageDomains(parsed);
    case 'firestore:discover':
      return await runFirestoreDiscover(parsed);
    default:
      process.stderr.write(`pyric: unknown command '${parsed.subcommand}'.\n\n`);
      printUsage();
      return 1;
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  return dispatch(parsed);
}

// Re-export parseArgs so the bin script + tests can share the parser.
export { parseArgs } from './parse-args.js';

// Always run `main()` — this file IS the bin entry. Tests in
// `cli.test.ts` import individual helpers (`./parse-args.js`,
// `./init.js`, `./deploy.js`, etc.) and never touch this module, so
// there's nothing to gate against. The previous `isDirectRun` check
// matched `process.argv[1]` against a `/cli/index.js` regex — on Linux,
// npm bin symlinks leave `argv[1]` as `node_modules/.bin/pyric` (NOT
// resolved through the symlink), the regex missed, main() never ran,
// and `pyric --help` printed nothing in CI. Dropping the guard fixes
// it. (Verified on Linux Node 20 in the packaging gate.)
main().then(
  (code) => exitAfterFlush(code),
  (err) => {
    process.stderr.write(
      `pyric: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    exitAfterFlush(2);
  },
);

/**
 * Drain stdout + stderr before exiting. `process.exit()` does NOT wait
 * for pipe-buffered output to flush — `process.stdout.write(text)`
 * against a pipe (which `bash -c '$(pyric --help)'` creates) queues
 * the data, and a bare `process.exit(0)` discards it on Linux Node 20.
 * Symptom: `pyric --help | cat` prints nothing in CI but works in a
 * TTY. The zero-byte write + callback pattern below queues behind any
 * pending writes and only exits once they've been flushed to the
 * underlying fd. See nodejs/node #6379.
 */
function exitAfterFlush(code: number): void {
  let pending = 2;
  const done = () => { if (--pending === 0) process.exit(code); };
  process.stdout.write('', done);
  process.stderr.write('', done);
}
