#!/usr/bin/env node
/**
 * `pyric` CLI — front door to the bridge + project tooling.
 *
 * Subcommands:
 *   pyric bridge [--port N] [--project ID]
 *   pyric sandbox [command...] [--port N] [--host H] [--no-cache] [--bridge] [--ui] [--seed FILE] [--no-watch] [--no-open] [--no-capture] [--no-run] [--json] [--persist] [--fresh] [-- <cmd>]
 *   pyric init [dir] [--template web|node] [--name N] [--force] [--json]
 *   pyric vendor [dir] [--json]
 *   pyric snapshot [--out FILE] [--port N] [--force] [--json] [--include-passwords]
 *   pyric mcp
 *   pyric firestore rules lint <path>
 *   pyric firestore rules validate <path>
 *   pyric firestore rules simulate [--stdin]
 *   pyric firestore rules resolve <path> [--out <path>]
 *   pyric firestore indexes generate <path...> [--out <path>]
 *   pyric storage rules lint <path>
 *   pyric storage rules resolve <path> [--out <path>]
 *   pyric storage rules simulate [--stdin]
 *   pyric database rules lint <path>
 *   pyric database rules validate <path>
 *   pyric database rules simulate [--stdin]
 *   pyric database rules generate [--config <path>] [--out <path>]
 *   pyric --help
 *   pyric --version
 *
 * Env vars:
 *   PYRIC_PORT                       — bridge port (default 5174)
 *   PYRIC_PROJECT                    — project label for bridge health and audit output
 *   PYRIC_VERBOSE                    — set to 1 for per-tool-call logging
 *   FIREBASE_SA_BASE64               — base64-encoded service-account JSON (Rules Test API verify)
 *   GOOGLE_APPLICATION_CREDENTIALS   — path to service-account JSON (Rules Test API verify)
 *
 * Exit codes:
 *   0  success
 *   1  usage error
 *   2  runtime error
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParsedArgs } from './parse-args.js';
import { runInit, runVendor } from './init.js';
import { runSnapshot } from './snapshot.js';
import { runVerify } from './verify.js';
import { runMcpProxy } from './mcp-proxy.js';
import { pyricVersion } from '../serve/standalone-assets.js';
import { cliVersion } from '../pkg-version.js';
import { FIREBASE_TESTED_AGAINST } from '../version/compat-target.js';
import { dispatchServiceCommand } from './service-commands.js';

// The standalone binary bakes the real `pyric` version onto the embedded-assets
// global; the npm bin has no such global and falls back to '0.0.0'.
const VERSION = pyricVersion();

function printUsage(): void {
  process.stdout.write(`pyric ${VERSION}
Firebase for agents — bridge an in-browser pyric sandbox to external MCP
clients (Claude Code, Cursor, ...).

USAGE
  pyric bridge [flags]
  pyric sandbox [command...] [flags]
  pyric init [dir] [--template=web|node]
  pyric snapshot [--out=FILE]
  pyric verify [fixture|dir] [--engine sandbox|rules-test-api|both]
  pyric can-i-use <feature> [--json]
  pyric verify cases [fixture] [--service firestore] [--out FILE]
  pyric firestore rules lint <path>
  pyric firestore rules validate <path>
  pyric firestore rules simulate [--stdin]
  pyric firestore rules resolve <path> [--out <path>]
  pyric firestore indexes generate <path...> [--out <path>]
  pyric storage rules lint <path>
  pyric storage rules resolve <path> [--out <path>]
  pyric storage rules simulate [--stdin]
  pyric database rules lint <path>
  pyric database rules validate <path>
  pyric database rules simulate [--stdin]
  pyric database rules generate [--config <path>] [--out <path>]
  pyric --help
  pyric --version

COMMANDS
  bridge                     Start the HTTP+WebSocket bridge external MCP clients point at.
  sandbox [command...]       Run an application command or script inside the local Firebase sandbox
                             with unmodified firebase/* and firebase-admin/* imports routed to the
                             in-memory mirror. When [command...] is omitted, runs the command
                             configured in pyric.json; if none is configured, runs the sandbox host only.
                             A firebase.json Functions source is discovered automatically;
                             supported RTDB onValueCreated exports run in isolated Node.
  init [dir]                 Scaffold a pyric project. --template=web (default; Vite app
                             on \`@pyric/cli/vite\`), static (\`pyric sandbox\`), or node.
                             --name=NAME --force (overwrite scaffold files) --json (machine
                             output on stdout). Never prompts; rerunning is safe.
                             Greenfield shortcut: \`npm create pyric [dir]\`.
  vendor [dir]               Retrofit: vendor pyric + @pyric/cli into an existing
                             project (lay file: tarballs into vendor/ + merge their
                             deps into package.json). Scaffolds nothing. Then run
                             bun install. Standalone binary only.
  mcp                        Stdio MCP server for editors (Cursor / Claude /
                             Antigravity). Hosts a headless in-process sandbox,
                             or attaches to a running \`pyric sandbox --bridge\`
                             (found via .pyric/serve.json) for shared-live Studio.
  snapshot [--out=FILE]      Promote lived sandbox state (live dev --persist, else
                             .pyric/state/state.json) to a committable fixture that
                             \`pyric sandbox --seed FILE\` re-serves. Passwords are redacted
                             by default (--include-passwords keeps them). --port, --force, --json.
  verify [fixture|dir]       Replay a captured sandbox session against candidate rules
                             for the Firestore/RTDB services present in the fixture.
                             No arg replays the latest \`pyric sandbox\` capture
                             (.pyric/last-session.json). --service filters services.
                             --engine sandbox (default), rules-test-api, or both.
                             Hosted Rules Test API verification is Firestore-only
                             and uses --project plus the configured Google credentials.
                             --rules service=path overrides firebase.json resolution
                             (repeat for mixed captures). --json. Exit 1 on divergence.
  can-i-use <feature>        Report Pyric availability, behavior fidelity, and assurance
                             eligibility from the canonical conformance model. A surface
                             prefix such as firestore-rules/getAfter disambiguates names.
                             Exact and fuzzy queries use the same model as MCP. --json.
  verify cases [fixture]     Derive Firestore Rules Test API cases from a captured
                             fixture and print JSON, or write with --out FILE.
  firestore rules lint       Run the Firestore rules linter against a file.
  firestore rules validate   Validate Firestore rules structure against a file.
  firestore rules simulate   Run the local Firestore rules simulator.
  firestore rules resolve    Resolve Firestore 2+modules imports to one ruleset.
  firestore indexes generate Generate firestore.indexes.json from application source.
  storage rules lint         Check Storage rules syntax locally.
  storage rules resolve      Resolve Storage 2+modules imports to one ruleset.
  storage rules simulate     Run the local Storage rules evaluator.
  database rules lint        Run the Realtime Database rules expression linter.
  database rules validate    Validate Realtime Database rules expressions.
  database rules simulate    Run the local Realtime Database rules simulator.
  database rules generate    Compile a constraints module to database.rules.json.
CORE FLAGS (sandbox)
  --port             Port to serve on. Default 3473 — "FIRE" on a phone keypad (scans forward when taken;
                     macOS AirPlay squats 5000).
  --host             Host to bind. Default localhost.
  --no-cache         Rebuild the served pyric SDK bundles (skip ~/.pyric/serve-cache).
  --only hosting     Accepted for firebase-serve parity (hosting is all v1 serves).
  --bridge           Also mount the MCP bridge on the serve origin — agents point
                     at http://<host>:<port>/__pyric/mcp and drive the sandbox
                     living in the served page. --project labels health/audit.
  --ui               Also serve the unified site at <url>/__pyric/ui/ (Studio
                     hub at /__pyric/ui/studio) and mount its disk-backed
                     workspace + project data routes. Auto-opens Studio
                     instead of the served page. Needs a full build so the
                     app assets are present.
  --seed FILE        JSON map of "collection/doc" → fields, loaded admin-style.
                     Also accepts a pyric state file (from \`pyric snapshot\`,
                     detected by its version key) — seeds docs + auth users.
                     into the page sandbox before app code runs.
  --no-watch         Disable firestore.rules hot-reload (on by default).
  --no-open          Don't auto-open the browser. dev opens the served page
                     by default (the sandbox is browser-resident); auto-open
                     is already suppressed under --json, no TTY, and CI.
  --no-capture       Don't write the session capture. dev writes
                     .pyric/last-session.json by default so \`pyric verify\`
                     can replay your session; --no-capture disables it.
  --allowed-host H   Allow an extra Host header past the DNS-rebinding guard
                     (comma-separated; localhost/127.0.0.1 always allowed).
  --persist          Persist sandbox state (docs + auth users) to
                     .pyric/state/state.json — survives reloads and dev
                     restarts. Once a state file exists it wins; --seed
                     applies only on the first (state-less) run. Ephemeral
                     is the default.
  --fresh            Requires --persist: discard the existing state file and
                     re-seed from scratch (escape hatch when you've edited
                     seed.json). Without --persist, --fresh errors — there is
                     no state file to discard. Half-reset warning: a browser
                     tab that already has sandbox data in IndexedDB keeps it
                     and writes it back to the new file; also clear the
                     browser store (Studio → Settings → Reset, or an
                     incognito window) for a full reset.
  -- <cmd>           Run <cmd> once the host is up, with PYRIC_SANDBOX set and
                     NODE_OPTIONS extended with --import @pyric/cli/register
                     so firebase-admin/firebase resolve to the sandbox. When
                     omitted, the package.json \`dev\` script runs (via the
                     detected package manager); no script → host-only.
  --no-run           Don't run the project's dev command (for users with their
                     own process manager). A declared Functions source still
                     runs. --json skips the dev command unless a \`-- <cmd>\`
                     is given explicitly.
  --json             One machine-readable line on stdout ({url, port, mcpUrl,
                     rulesHash, persist, restoredDocs, restoredUsers}); the
                     banner moves to stderr. Readiness probe:
                     GET <url>/__pyric/init.json → 200 (live rules hash).

CORE FLAGS (bridge)
  --port             Port to bind on 127.0.0.1. Default 5174. Env: PYRIC_PORT.
  --project          Project label surfaced in /health + audit output.
                     Env: PYRIC_PROJECT.

CREDENTIALS
  Rules Test API verification resolves existing Google credentials:
    1. FIREBASE_SA_BASE64            base64-encoded service-account JSON (CI)
    2. GOOGLE_APPLICATION_CREDENTIALS  path to a service-account JSON file
    3. ADC                           \`gcloud auth application-default login\` (ambient)
  PYRIC_PROJECT / --project          Firebase project id for Rules Test API verification
`);
}

function printVersion(): void {
  process.stdout.write(
    `@pyric/cli ${cliVersion()}\n` +
      `Firebase ${FIREBASE_TESTED_AGAINST} (conformance-tested against this release)\n`,
  );
}

async function runBridge(parsed: ParsedArgs): Promise<number> {
  const removedFlags = [
    'mode',
    'auto-approve',
    'require-confirm',
    'require-confirm-all',
    'confirm-timeout',
    'non-interactive',
  ];
  for (const flag of removedFlags) {
    if (parsed.flags.has(flag)) {
      process.stderr.write(`pyric: unknown option '--${flag}' for pyric bridge.\n`);
      return 1;
    }
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

  let handle;
  try {
    const { startServer } = await import('@pyric/cli/bridge');
    handle = await startServer({
      port,
      project,
    });
  } catch (err) {
    process.stderr.write(
      `pyric: failed to start bridge: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

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

  process.stdout.write(
    `\npyric bridge ${VERSION} ready\n` +
      `  target:  sandbox\n` +
      `  project: ${handle.bridge.project}\n` +
      `  health:  ${handle.url}/health\n` +
      `  mcp:     ${handle.url}/mcp\n` +
      `  sandbox: ${handle.url.replace('http://', 'ws://')}/sandbox\n` +
      (handle.auditLogPath ? `  audit:   ${handle.auditLogPath}\n` : '') +
      `\nRegister with Claude Code:\n` +
      `  claude mcp add --transport http pyric ${handle.url}/mcp --scope project\n` +
      `\nBridge will log peer connect/disconnect to stderr. Set PYRIC_VERBOSE=1 for per-tool-call logs.\n` +
      `Press Ctrl-C to stop.\n`,
  );

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

  const serviceCommand = await dispatchServiceCommand(parsed);
  if (serviceCommand !== null) return serviceCommand;

  switch (parsed.subcommand) {
    case null:
    case undefined:
      printUsage();
      return parsed.subcommand === null ? 0 : 1;
    case 'bridge':
      return await runBridge(parsed);
    case 'sandbox':
      const { runServe } = await import('./serve.js');
      return runServe(parsed);
    case 'snapshot':
      return await runSnapshot(parsed);
    case 'verify':
      return await runVerify(parsed);
    case 'can-i-use':
      const { runCanIUse } = await import('./can-i-use.js');
      return runCanIUse(parsed);
    case 'mcp':
      return await runMcpProxy(parsed);
    case 'init':
      return await runInit(parsed);
    case 'vendor':
      return await runVendor(parsed);
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

/**
 * True when this module is the executable entry rather than an import.
 *
 * Bun identifies source and compiled entry points with `import.meta.main`.
 * Node does not, so compare real paths there: resolving both sides preserves
 * npm's `node_modules/.bin/pyric` symlink behavior that a textual path check
 * previously broke.
 */
export function isDirectRun(): boolean {
  if (import.meta.main) return true;
  const argvEntry = process.argv[1];
  if (!argvEntry) return false;
  try {
    return realpathSync(argvEntry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * Explicit executable entry: parse argv, dispatch, flush, exit.
 *
 * The compiled standalone binary calls this from its generated entry
 * (scripts/compile.ts) instead of relying on {@link isDirectRun}: inside a
 * `bun build --compile` binary this module is an import (import.meta.main is
 * false) and `process.argv[1]` is the user's first argument, not a path — so
 * direct-run detection is structurally false there and the binary would
 * otherwise exit 0 silently.
 */
export function runDirect(): void {
  main().then(
    (code) => exitAfterFlush(code),
    (err) => {
      process.stderr.write(
        `pyric: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      exitAfterFlush(2);
    },
  );
}

if (isDirectRun()) runDirect();

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
