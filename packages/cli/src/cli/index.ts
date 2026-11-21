#!/usr/bin/env node
/**
 * `pyric` CLI front door to the bridge and project tooling.
 *
 * Subcommands:
 *   pyric bridge [--port N] [--project ID]
 *   pyric sandbox [flags] [--] [command...]
 *   pyric run [--sandbox URL] [--wait[=SECONDS]] -- <command...>
 *   pyric init [dir] [--template web|node] [--name N] [--force] [--json]
 *   pyric vendor [dir] [--json]
 *   pyric snapshot [--out DIR] [--port N] [--force] [--json] [--include-passwords]
 *   pyric mcp
 *   pyric firestore rules validate <path>
 *   pyric firestore rules resolve <path> [--out <path>]
 *   pyric firestore indexes generate <path...> [--out <path>]
 *   pyric storage rules resolve <path> [--out <path>]
 *   pyric database rules validate <path> [--fail-on <critical|high|medium>]
 *   pyric database rules generate [--config <path>] [--out <path>] [--fail-on <critical|high|medium>]
 *   pyric database indexes generate <path...> [--rules <path>] [--out <path>] [--check] [--instance <name>]
 *   pyric serve diagnostics [--url URL] [--json]
 *   pyric serve sessions [--json]
 *   pyric serve denials [--json] [--since <ms|duration>] [--service rtdb|firestore]
 *   pyric serve repro capture [--out FILE]
 *   pyric serve repro replay <file> [--plane node|worker] [--json]
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
import { parseArgs, type FlagValue, type ParsedArgs } from './parse-args.js';
import { cliVersion } from '../pkg-version.js';
import { FIREBASE_TESTED_AGAINST } from '../version/compat-target.js';

// Each command's module is imported when that command runs, never at startup.
// The service commands alone load about 500 modules, the TypeScript compiler
// among them, which made every `pyric run` spend about 0.5 s at idle (over 3 s
// on a loaded CI runner) before its first request (#1671).

/**
 * The commands this dispatcher runs itself that no service command starts
 * with, so they skip loading the service command registry. `sandbox` is not
 * here: `pyric sandbox inspect` is a service command.
 */
export const COMMANDS_BEFORE_SERVICES: ReadonlySet<string> = new Set([
  'bridge',
  'run',
  'snapshot',
  'verify',
  'can-i-use',
  'mcp',
  'init',
  'vendor',
]);

async function dispatchServiceCommand(parsed: ParsedArgs): Promise<number | null> {
  const subcommand = parsed.subcommand;
  const skipsServices = subcommand == null || COMMANDS_BEFORE_SERVICES.has(subcommand);
  if (skipsServices) return null;
  const services = await import('./service-commands.js');
  return services.dispatchServiceCommand(parsed);
}

async function printGlobalUsage(): Promise<void> {
  const { renderGlobalUsage } = await import('./help.js');
  process.stdout.write(renderGlobalUsage());
}

function printVersion(): void {
  process.stdout.write(
    `@pyric/cli ${cliVersion()}\n` +
      `Firebase ${FIREBASE_TESTED_AGAINST} (conformance-tested against this release)\n`,
  );
}

function resolveRawBridgePort(
  flagPort: FlagValue | undefined,
  envPort: string | undefined,
): string | undefined {
  if (flagPort !== undefined) {
    if (typeof flagPort === 'string') return flagPort;
    if (Array.isArray(flagPort)) return flagPort.map(String).join(',');
    return '';
  }
  if (envPort !== undefined && envPort !== '') return envPort;
  return undefined;
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

  const rawPort = resolveRawBridgePort(parsed.flags.get('port'), process.env.PYRIC_PORT);
  let port: number | undefined;
  if (rawPort !== undefined) {
    const parsedPort = Number(rawPort);
    const isValidPort =
      rawPort.trim().length > 0 &&
      !Object.is(parsedPort, -0) &&
      Number.isInteger(parsedPort) &&
      parsedPort >= 0 &&
      parsedPort <= 65535;
    if (!isValidPort) {
      process.stderr.write(`pyric: invalid --port '${rawPort}'.\n`);
      return 1;
    }
    port = parsedPort;
  }

  const flagProject = parsed.flags.get('project');
  const project =
    typeof flagProject === 'string' ? flagProject : process.env.PYRIC_PROJECT ?? undefined;

  if (parsed.flags.has('no-session-token') || parsed.flags.get('session-token') === 'false') {
    process.stderr.write(`pyric: unknown option '--no-session-token' for pyric bridge.\n`);
    return 1;
  }
  const { readPyricConfig } = await import('./pyric-config.js');
  const pyricConfig = await readPyricConfig(process.cwd()).catch(() => ({} as { sessionToken?: boolean }));
  const requireSessionToken =
    parsed.flags.get('session-token') === true || pyricConfig.sessionToken === true;

  let allowedHosts: string[] | undefined;
  let allowPeers: 'loopback' | 'any' | string[] | undefined;
  let trustProxy: false | 'loopback' | string[] | undefined;
  try {
    const rawAllowedHost = parsed.flags.get('allowed-host');
    const rawAllowPeers = parsed.flags.get('allow-remote-peers');
    const rawTrustProxy = parsed.flags.get('trust-proxy');
    const envAllowed = process.env.PYRIC_ALLOWED_HOSTS;
    const envPeers = process.env.PYRIC_ALLOW_REMOTE_PEERS;
    const envTrust = process.env.PYRIC_TRUST_PROXY;
    const hasRemoteFlag =
      rawAllowedHost !== undefined ||
      rawAllowPeers !== undefined ||
      rawTrustProxy !== undefined ||
      (envAllowed !== undefined && envAllowed.trim().length > 0) ||
      (envPeers !== undefined && envPeers.trim().length > 0) ||
      (envTrust !== undefined && envTrust.trim().length > 0);
    if (hasRemoteFlag) {
      const {
        parseAllowedHostsInput,
        parseAllowRemotePeersInput,
        parseTrustProxyInput,
      } = await import('../serve/remote-access-parse.js');
      if (rawAllowedHost !== undefined) {
        if (typeof rawAllowedHost === 'boolean') {
          throw new Error('pyric: --allowed-host requires a hostname or comma-separated list.');
        }
        let hostInputs: string[];
        if (Array.isArray(rawAllowedHost)) {
          hostInputs = rawAllowedHost.filter((value): value is string => typeof value === 'string');
        } else {
          hostInputs = [rawAllowedHost];
        }
        allowedHosts = parseAllowedHostsInput(hostInputs);
      } else if (envAllowed !== undefined && envAllowed.trim().length > 0) {
        allowedHosts = parseAllowedHostsInput(envAllowed);
      }
      if (rawAllowPeers !== undefined) {
        const lastPeer = Array.isArray(rawAllowPeers) ? rawAllowPeers[rawAllowPeers.length - 1] : rawAllowPeers;
        if (lastPeer !== undefined) {
          allowPeers = parseAllowRemotePeersInput(lastPeer);
        }
      } else if (envPeers !== undefined && envPeers.trim().length > 0) {
        allowPeers = parseAllowRemotePeersInput(envPeers);
      }
      if (rawTrustProxy !== undefined) {
        const lastTrust = Array.isArray(rawTrustProxy) ? rawTrustProxy[rawTrustProxy.length - 1] : rawTrustProxy;
        if (lastTrust !== undefined) {
          trustProxy = parseTrustProxyInput(lastTrust);
        }
      } else if (envTrust !== undefined && envTrust.trim().length > 0) {
        trustProxy = parseTrustProxyInput(envTrust);
      }
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  let remoteAccess:
    | {
        allowedHosts?: string[];
        allowPeers?: 'loopback' | 'any' | string[];
        trustProxy?: false | 'loopback' | string[];
      }
    | undefined;
  if (allowedHosts !== undefined || allowPeers !== undefined || trustProxy !== undefined) {
    remoteAccess = {
      allowedHosts,
      allowPeers,
      trustProxy,
    };
  }

  let handle;
  try {
    const { startServer } = await import('@pyric/cli/bridge');
    handle = await startServer({
      port,
      project,
      allowedHosts,
      requireSessionToken,
      remoteAccess,
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

  const headerArg = requireSessionToken
    ? ` --header "x-pyric-session-token: ${handle.sessionToken}"`
    : '';
  process.stdout.write(
    `\npyric bridge ${cliVersion()} ready\n` +
      `  target:  sandbox\n` +
      `  project: ${handle.bridge.project}\n` +
      `  health:  ${handle.url}/health\n` +
      `  mcp:     ${handle.mcpUrl}\n` +
      (handle.auditLogPath ? `  audit:   ${handle.auditLogPath}\n` : '') +
      `\nRegister with Claude Code:\n` +
      `  claude mcp add --transport http pyric ${handle.mcpUrl}${headerArg} --scope project\n` +
      `\nThis bridge serves the tools that run in this process. A browser page cannot attach to it;\n` +
      `for an agent that drives the sandbox in a page, run \`pyric sandbox --bridge\`.\n` +
      `Set PYRIC_VERBOSE=1 for per-tool-call logs.\n` +
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
  const asksForHelp = Boolean(parsed.flags.get('help') || parsed.flags.get('h'));
  if (asksForHelp) {
    const { renderHelp } = await import('./help.js');
    const output = await renderHelp(parsed);
    if (output.exitCode === 0) {
      process.stdout.write(output.text);
    } else {
      process.stderr.write(output.text);
    }
    return output.exitCode;
  }
  const asksForVersion = Boolean(parsed.flags.get('version') || parsed.flags.get('v'));
  if (asksForVersion) {
    printVersion();
    return 0;
  }

  if (parsed.subcommand === 'sandbox' && parsed.positional[0] === 'seed-from-live') {
    const { runSeedFromLive } = await import('./seed-from-live.js');
    return runSeedFromLive(parsed);
  }

  if (parsed.subcommand === 'assurance' && parsed.positional[0] === 'derive') {
    const { runAssuranceDerive } = await import('./assurance.js');
    return runAssuranceDerive(parsed);
  }

  const serviceCommand = await dispatchServiceCommand(parsed);
  const isServiceCommand = serviceCommand !== null;
  if (isServiceCommand) return serviceCommand;

  switch (parsed.subcommand) {
    case null:
    case undefined: {
      await printGlobalUsage();
      if (parsed.subcommand === null) return 0;
      return 1;
    }
    case 'bridge':
      return await runBridge(parsed);
    case 'sandbox': {
      const isSalvage = parsed.positional[0] === 'salvage';
      if (isSalvage) {
        const { runSalvage } = await import('./salvage.js');
        return runSalvage(parsed);
      }
      if ((parsed.passthrough?.length ?? 0) === 0 && parsed.positional.length > 0) {
        const { checkAmbiguousSandboxWord } = await import('./sandbox-word-guard.js');
        const refusal = checkAmbiguousSandboxWord(parsed);
        if (refusal !== null) {
          process.stderr.write(refusal);
          return 1;
        }
      }
      const { runServe } = await import('./serve.js');
      return runServe(parsed);
    }
    case 'run': {
      const { runRun } = await import('./run.js');
      return runRun(parsed);
    }
    case 'snapshot': {
      const { runSnapshot } = await import('./snapshot.js');
      return await runSnapshot(parsed);
    }
    case 'verify': {
      const { runVerify } = await import('./verify.js');
      return await runVerify(parsed);
    }
    case 'can-i-use': {
      const { runCanIUse } = await import('./can-i-use.js');
      return runCanIUse(parsed);
    }
    case 'mcp': {
      const { runMcpProxy } = await import('./mcp-proxy.js');
      return await runMcpProxy(parsed);
    }
    case 'init': {
      const { runInit } = await import('./init.js');
      return await runInit(parsed);
    }
    case 'vendor': {
      const { runVendor } = await import('./init.js');
      return await runVendor(parsed);
    }
    default: {
      const help = await import('./help.js');
      if (parsed.positional.length === 0) {
        const bareTool = await help.renderBareTool(parsed.subcommand);
        if (bareTool !== null) {
          process.stdout.write(bareTool);
          return 0;
        }
      } else {
        const unknownMethod = await help.formatUnknownToolMethod(
          parsed.subcommand,
          parsed.positional,
        );
        if (unknownMethod !== null) {
          process.stderr.write(unknownMethod);
          return 1;
        }
      }
      process.stderr.write(
        `pyric: unknown command '${[parsed.subcommand, ...parsed.positional].join(' ')}'.\n\n`,
      );
      process.stdout.write(help.renderGlobalUsage());
      return 1;
    }
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
