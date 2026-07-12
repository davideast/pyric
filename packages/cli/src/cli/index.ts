#!/usr/bin/env node
/**
 * `pyric` CLI — front door to the bridge + project tooling.
 *
 * Subcommands:
 *   pyric bridge [--port N] [--project ID] …
 *   pyric dev [--port N] [--host H] [--no-cache] [--bridge] [--ui] [--seed FILE] [--no-watch] [--no-open] [--no-capture] [--no-run] [--json] [--persist] [--fresh] [-- <cmd>]
 *   pyric init [dir] [--template web|node] [--name N] [--force] [--json]
 *   pyric vendor [dir] [--json]
 *   pyric snapshot [--out FILE] [--port N] [--force] [--json] [--include-passwords]
 *   pyric mcp
 *   pyric firestore rules lint <path>
 *   pyric firestore rules validate <path>
 *   pyric firestore rules simulate [--stdin]
 *   pyric firestore rules resolve <path> [--out <path>]
 *   pyric firestore indexes generate <path...> [--out <path>]
 *   pyric database rules lint <path>
 *   pyric database rules validate <path>
 *   pyric database rules simulate [--stdin]
 *   pyric database rules generate [--config <path>] [--out <path>]
 *   pyric --help
 *   pyric --version
 *
 * Env vars:
 *   PYRIC_PORT                       — bridge port (default 5174)
 *   PYRIC_PROJECT                    — project label and hosted-verification project id
 *   PYRIC_VERBOSE                    — set to 1 for per-tool-call logging
 *   FIREBASE_SA_BASE64               — base64-encoded service-account JSON (hosted verification)
 *   GOOGLE_APPLICATION_CREDENTIALS   — service-account JSON or ADC path (hosted verification)
 *   Existing `firebase login` and gcloud ADC credentials are also read-only sources.
 *
 * Exit codes:
 *   0  success
 *   1  usage error
 *   2  runtime error
 */

import { startServer } from '../bridge/server.js';
import { parseArgs, type ParsedArgs } from './parse-args.js';
import {
  runFirestoreIndexesGenerate,
  runFirestoreRulesResolve,
  runRulesLint,
  runRulesValidate,
  runRulesSimulate,
} from './rules.js';
import {
  runDatabaseRulesLint,
  runDatabaseRulesValidate,
  runDatabaseRulesSimulate,
  runDatabaseRulesGenerate,
} from './database-rules.js';
import { runInit, runVendor } from './init.js';
import { runServe } from './serve.js';
import { runSnapshot } from './snapshot.js';
import { runVerify } from './verify.js';
import { runMcpProxy } from './mcp-proxy.js';
import { pyricVersion } from '../serve/standalone-assets.js';
import { pyricCliVersion } from '../pkg-version.js';
import { FIREBASE_TESTED_AGAINST } from '../version/compat-target.js';

// The standalone binary bakes the real `pyric` version onto the embedded-assets
// global; the npm bin has no such global and falls back to '0.0.0'.
const VERSION = pyricVersion();

function printUsage(): void {
  process.stdout.write(`pyric ${VERSION}
Local Firebase development and verification.

USAGE
  pyric init [dir] [--template=web|node]
  pyric dev [flags] [-- <cmd>]
  pyric bridge [--port N] [--project ID]
  pyric mcp
  pyric snapshot [--out=FILE]
  pyric verify [fixture|dir] [--service firestore|database]
  pyric verify cases [fixture] [--service firestore] [--out FILE]
  pyric vendor [dir]
  pyric firestore rules lint <path>
  pyric firestore rules validate <path>
  pyric firestore rules simulate [--stdin]
  pyric firestore rules resolve <path> [--out <path>]
  pyric firestore indexes generate <path...> [--out <path>]
  pyric database rules lint <path>
  pyric database rules validate <path>
  pyric database rules simulate [--stdin]
  pyric database rules generate [--config <path>] [--out <path>]
  pyric --help
  pyric --version

VERIFY
  Replays every supported service found in the capture. Repeat --service to
  filter. The rules-test-api engine is Firestore-only and uses Application
  Firebase CLI login, Application Default Credentials, or service-account env.
`);
}

function printVersion(): void {
  process.stdout.write(
    `@pyric/cli ${pyricCliVersion()}\n` +
      `Firebase ${FIREBASE_TESTED_AGAINST} (conformance-tested against this release)\n`,
  );
}

async function runBridge(parsed: ParsedArgs): Promise<number> {
  if (parsed.flags.has('mode')) {
    process.stderr.write('pyric: bridge is sandbox-only; --mode is not supported.\n');
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
  let handle;
  try {
    handle = await startServer({
      mode: 'sandbox',
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
      `  mode:    ${handle.bridge.mode}\n` +
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

  switch (parsed.subcommand) {
    case null:
    case undefined:
      printUsage();
      return parsed.subcommand === null ? 0 : 1;
    case 'bridge':
      return await runBridge(parsed);
    case 'dev':
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
    case 'firestore':
      return await runFirestoreCommand(parsed);
    case 'database':
      return await runDatabaseCommand(parsed);
    default:
      process.stderr.write(`pyric: unknown command '${parsed.subcommand}'.\n\n`);
      printUsage();
      return 1;
  }
}

function scopedArgs(parsed: ParsedArgs, consumed: number): ParsedArgs {
  return { ...parsed, positional: parsed.positional.slice(consumed) };
}

async function runFirestoreCommand(parsed: ParsedArgs): Promise<number> {
  const [namespace, command] = parsed.positional;
  const args = scopedArgs(parsed, 2);
  if (namespace === 'rules') {
    if (command === 'lint') return runRulesLint(args);
    if (command === 'validate') return runRulesValidate(args);
    if (command === 'simulate') return runRulesSimulate(args);
    if (command === 'resolve') return runFirestoreRulesResolve(args);
  }
  if (namespace === 'indexes' && command === 'generate') {
    return runFirestoreIndexesGenerate(args);
  }
  process.stderr.write(`pyric: unknown firestore command '${[namespace, command].filter(Boolean).join(' ')}'.\n`);
  return 1;
}

async function runDatabaseCommand(parsed: ParsedArgs): Promise<number> {
  const [namespace, command] = parsed.positional;
  const args = scopedArgs(parsed, 2);
  if (namespace === 'rules') {
    if (command === 'lint') return runDatabaseRulesLint(args);
    if (command === 'validate') return runDatabaseRulesValidate(args);
    if (command === 'simulate') return runDatabaseRulesSimulate(args);
    if (command === 'generate') return runDatabaseRulesGenerate(args);
  }
  process.stderr.write(`pyric: unknown database command '${[namespace, command].filter(Boolean).join(' ')}'.\n`);
  return 1;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  return dispatch(parsed);
}

// Re-export parseArgs so the bin script + tests can share the parser.
export { parseArgs } from './parse-args.js';

// Always run `main()` — this file IS the bin entry. Tests in
// `cli.test.ts` import individual helpers (`./parse-args.js`,
// `./init.js`, `./rules.js`, etc.) and never touch this module, so
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
