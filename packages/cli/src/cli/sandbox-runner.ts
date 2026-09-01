/**
 * The `pyric sandbox` child runner starts the configured application command
 * after the host is ready:
 * after the host is up, run the user's OWN dev command with the environment
 * activated so their unchanged firebase-admin/firebase imports resolve to the
 * pyric sandbox:
 *
 *   PYRIC_SANDBOX=remote:<serve url>          (the activator)
 *   NODE_OPTIONS += --import @pyric/cli/register   (the substitution seam)
 *
 * Child-command precedence: `--no-run`, an explicit command, `--json`, the
 * `pyric.json` command, then host-only. An explicit command still runs with
 * `--json`.
 *
 * Everything decision-shaped here is pure and exported for the unit suite;
 * only `spawnDevChild` touches the process table.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { beaconEndpoint } from '../register/beacon.js';
import { parseGuardMode, type GuardMode } from '../register/net-guard.js';
// Type-only: erased at compile, so this never closes a cycle with serve.ts
// (which imports this module for the child plan and spawn).
import type { InlinedFirebaseHit } from './serve.js';

// ─── First-run race guard ───────────────────────────────────────────────────

/**
 * Wait (bounded) for a browser tab to register as the bridge's sandbox peer
 * before the child spawns. `pyric sandbox` opens the tab and spawns the child in
 * the same breath; a child whose first line is a sandbox op otherwise races
 * the tab's boot and dies on the no-tab fail-fast — the exact first-run of
 * the two-command story. Polls `/__pyric/health` (`sandboxConnected`).
 *
 * Returns true when a peer connected, false on timeout (caller warns and
 * spawns anyway — the child may not touch the sandbox at all). Injectable
 * clock/fetch for the unit suite.
 */
export async function waitForSandboxPeer(
  serveUrl: string,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 250;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetchImpl(`${serveUrl.replace(/\/$/, '')}/__pyric/health`);
      if (res.ok) {
        const health = (await res.json()) as { sandboxConnected?: boolean };
        if (health.sandboxConnected === true) return true;
      }
    } catch {
      // Health not up yet — keep polling until the deadline.
    }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

// ─── Child-command resolution (pure) ───────────────────────────────────────

export interface SandboxChildPlan {
  /** argv to spawn — argv[0] is the executable. */
  argv: string[];
  /** Human-readable command for the pre-spawn line. */
  label: string;
}

export type DevChildPlan = SandboxChildPlan;

/**
 * Tokenize a command string into an argv array, preserving quoted strings.
 */
export function parseCommandString(cmd: string): string[] {
  const parts: string[] = [];
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cmd)) !== null) {
    if (match[1] !== undefined) {
      parts.push(match[1]);
    } else if (match[2] !== undefined) {
      parts.push(match[2]);
    } else {
      parts.push(match[0]);
    }
  }
  return parts;
}

export interface ResolveSandboxChildOptions {
  explicitCommand?: string[] | null;
  passthrough?: string[];
  configCommand?: string | null;
  noRun?: boolean;
  json?: boolean;
}

/**
 * Decide what (if anything) to run after the host is up.
 *
 * Precedence:
 *   --no-run                                → null, always
 *   explicit CLI command (args or `--`)     → that command (wins over everything else)
 *   --json (with no explicit command)       → null (machine mode defaults to host-only)
 *   pyric.json `command`                    → parsed command argv
 *   none of the above                       → null (host-only)
 */
export function resolveSandboxChild(opts: ResolveSandboxChildOptions): SandboxChildPlan | null {
  if (opts.noRun) return null;

  let activeCommand: string[] | null = null;
  if (opts.explicitCommand && opts.explicitCommand.length > 0) {
    activeCommand = opts.explicitCommand;
  } else if (opts.passthrough && opts.passthrough.length > 0) {
    activeCommand = opts.passthrough;
  }

  if (activeCommand !== null) {
    return { argv: [...activeCommand], label: activeCommand.join(' ') };
  }

  if (opts.json) return null;

  if (opts.configCommand && opts.configCommand.trim().length > 0) {
    const trimmed = opts.configCommand.trim();
    const argv = parseCommandString(trimmed);
    return { argv, label: trimmed };
  }

  return null;
}

// ─── Environment for the child (pure) ──────────────────────────────────────

/**
 * The absolute `file:` URL of the register module, resolved from
 * @pyric/cli' OWN installed location — `import.meta.resolve` walks this
 * package's `exports` (self-reference), so it lands on the right file no
 * matter how the user's node_modules are laid out (hoisted, pnpm-isolated,
 * vendored). Fallback: relative to this compiled file (dist/cli/ →
 * dist/register/), for runtimes without a usable import.meta.resolve.
 */
export function registerModuleUrl(): string {
  try {
    const url = import.meta.resolve('@pyric/cli/register');
    if (typeof url === 'string' && url.length > 0) return url;
  } catch {
    // fall through
  }
  return new URL('../register/index.js', import.meta.url).href;
}

/**
 * Child env: sets the activator and APPENDS the loader to NODE_OPTIONS —
 * never replaces it (the user's own --inspect / --max-old-space-size etc.
 * must survive). `file:` URLs are percent-encoded, so no quoting is needed
 * even for paths with spaces.
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  opts: { serveUrl: string; registerUrl: string },
): NodeJS.ProcessEnv {
  const importFlag = `--import ${opts.registerUrl}`;
  return {
    ...base,
    PYRIC_SANDBOX: `remote:${opts.serveUrl}`,
    NODE_OPTIONS: base.NODE_OPTIONS ? `${base.NODE_OPTIONS} ${importFlag}` : importFlag,
  };
}

/**
 * Format copy-pasteable POSIX export statements for host-only startup.
 * Grouped in a cleanly formatted console block for easy selection and copying
 * into a separate terminal (for example, when running Next.js independently).
 */
export function formatStartupEnvExport(opts: { serveUrl: string; registerUrl: string }): string {
  const pyricSandbox = `remote:${opts.serveUrl}`;
  const nodeOptions = `--import ${opts.registerUrl}`;
  const line1 = `export PYRIC_SANDBOX="${pyricSandbox}"`;
  const line2 = `export NODE_OPTIONS="${nodeOptions}"`;
  const divider = '─'.repeat(Math.max(line1.length, line2.length) + 4);
  return (
    '\n' +
    '  To run external commands against this sandbox, paste in another terminal:\n' +
    `  ${divider}\n` +
    `  ${line1}\n` +
    `  ${line2}\n` +
    `  ${divider}\n`
  );
}

// ─── The interlock: status line + warn-only beacon watchdog ────────────────

/**
 * What `pyric sandbox` can say about the interception it is ABOUT to hand the
 * child, entirely from the env it just assembled — no waiting, no probing.
 */
export interface InterlockStatus {
  /** Net-guard mode the child will run under (`PYRIC_GUARD`, default warn). */
  readonly guard: GuardMode;
  /** Whether `NODE_OPTIONS` actually carries the register `--import`. */
  readonly registerImported: boolean;
  /** Where the child's handshake beacon will land, or null when the
   *  activator carries no bridge URL. */
  readonly beacon: string | null;
}

/**
 * Read the interlock off the child env. Everything here is synchronous by
 * construction: it is a statement about the LAUNCH (what we set), printed
 * before anything at runtime has had a chance to go wrong.
 */
export function describeInterlock(
  childEnv: NodeJS.ProcessEnv,
  registerUrl: string,
): InterlockStatus {
  return {
    guard: parseGuardMode(childEnv.PYRIC_GUARD),
    registerImported: (childEnv.NODE_OPTIONS ?? '').includes(`--import ${registerUrl}`),
    beacon: beaconEndpoint(childEnv.PYRIC_SANDBOX),
  };
}

/** The startup status line, alongside the other `✔ <service>` checks. */
export function formatInterlockLine(status: InterlockStatus): string {
  const beacon = status.beacon ?? 'none';
  if (!status.registerImported) {
    return (
      `⚠ interlock guard=${status.guard} · register is NOT in the child's NODE_OPTIONS — ` +
      `its firebase-admin/firebase imports will NOT be rewritten and would reach LIVE Firebase · ` +
      `beacon=${beacon}\n`
    );
  }
  return (
    `✔ interlock guard=${status.guard} · register loaded via NODE_OPTIONS · beacon=${beacon}\n`
  );
}

/** How long a child may live without its beacon before we say something. */
const BEACON_GRACE_MS = 15_000;

export interface BeaconWatchdogOptions {
  /** The child command, for attribution in the warning. */
  readonly label: string;
  /** The endpoint the child would post to; null ⇒ nothing to watch. */
  readonly beacon: string | null;
  /** Whether a beacon from this child has been recorded. */
  readonly sawBeacon: () => boolean;
  /** Whether the child is still running. */
  readonly isAlive: () => boolean;
  readonly warn: (line: string) => void;
  readonly graceMs?: number;
}

export interface BeaconWatchdog {
  /** Cancel a pending check. Idempotent. */
  stop(): void;
}

/** The warning itself — one paragraph, naming what the silence means and what
 *  to check. Kept separate so its exact wording is testable. */
export function formatMissingBeaconWarning(opts: {
  label: string;
  graceMs: number;
  beacon: string;
}): string {
  const seconds = Math.round(opts.graceMs / 1000);
  return (
    `  ⚠ interlock: \`${opts.label}\` has been running ${seconds}s without posting a register ` +
    `beacon to ${opts.beacon} — its firebase-admin/firebase imports are probably NOT routed to ` +
    `the pyric sandbox, which means they would reach LIVE Firebase. Check that the command starts ` +
    `a Node process (bun and deno do not evaluate Node loader hooks), that it does not overwrite ` +
    `NODE_OPTIONS, and that NODE_ENV is not production. Warning only — nothing was blocked, and ` +
    `this is reported once per child.`
  );
}

/**
 * The warn-only interlock watchdog.
 *
 * PERMANENTLY warn-only, by adopted decision: it never kills the child and
 * never blocks a request. The reason is the signal's own honesty — beacon
 * delivery is best-effort (see `register/beacon.ts`), and a plausible silent
 * child is not the same thing as a broken one. A short-lived script that
 * exits before its POST lands, a child that reaches the sandbox only through
 * a grandchild, a dev server slow to boot: each would be killed by a
 * fail-closed version of this check, and each is fine.
 *
 * So the heuristic is deliberately the simple, attributable one: the child is
 * STILL ALIVE `graceMs` after launch and no beacon has arrived. Both halves
 * matter — an exited child was never expected to say anything, and a child
 * whose beacon landed has already proved the point. One warning per child,
 * guaranteed by the one-shot timer; the timer is unref'd so a watchdog can
 * never be the reason a process stays up.
 */
export function startBeaconWatchdog(opts: BeaconWatchdogOptions): BeaconWatchdog {
  const beacon = opts.beacon;
  if (beacon === null) return { stop: () => {} };
  const graceMs = opts.graceMs ?? BEACON_GRACE_MS;
  const timer = setTimeout(() => {
    if (opts.sawBeacon() || !opts.isAlive()) return;
    opts.warn(formatMissingBeaconWarning({ label: opts.label, graceMs, beacon }));
  }, graceMs);
  timer.unref?.();
  return {
    stop(): void {
      clearTimeout(timer);
    },
  };
}

// ─── Pre-flight artifact scan (pure formatting half) ───────────────────────

/**
 * The backend build outputs a launched child plausibly loads, relative to the
 * project root. `dist` and `build` are the generic bundler outputs, `functions`
 * the Cloud Functions source/output dir, and `.next/server` the Next.js server
 * bundle — the one that lives behind a dot-directory the default (frontend)
 * scan deliberately skips, and the one most likely to carry an inlined
 * firebase-admin. Missing dirs are skipped by the scanner, so an unbuilt
 * project costs a handful of `existsSync` calls.
 */
export const BACKEND_ARTIFACT_DIRS: readonly string[] = [
  'dist',
  'build',
  '.next/server',
  'functions',
];

/** How many per-file findings print before the rest collapse into a count. */
const PREFLIGHT_MAX_FILE_LINES = 10;

/**
 * Render the pre-flight findings, in the interlock's line style.
 *
 * WARN-ONLY, by adopted decision: a hit is evidence, not proof. The scanner
 * greps for a host literal, and a stale `dist/` from last month or a vendored
 * copy of someone else's bundle is a false positive that must never stop a
 * launch. So this returns lines to print and nothing else — no throw, no
 * refusal, no exit-code change. (The *served frontend* check in `serve.ts`
 * still throws; that one gates what pyric itself is about to serve, which is a
 * claim pyric makes, not a guess about the user's child process.)
 *
 * One line per file naming the catalog service and host, then one line saying
 * what a finding means and that nothing was blocked.
 */
export function formatInlinedArtifactWarnings(hits: readonly InlinedFirebaseHit[]): string[] {
  if (hits.length === 0) return [];
  const lines = hits
    .slice(0, PREFLIGHT_MAX_FILE_LINES)
    .map((h) => `  ⚠ preflight: ${h.file} inlines ${h.service} (${h.host})`);
  const remaining = hits.length - lines.length;
  if (remaining > 0) lines.push(`  ⚠ preflight: …and ${remaining} more file(s)`);
  const noun = hits.length === 1 ? 'build artifact contains' : 'build artifacts contain';
  lines.push(
    `  ⚠ preflight: ${hits.length} ${noun} inlined production Firebase SDK code, which bypasses ` +
      `pyric's module swap — the SDK is compiled INTO the artifact, so there is no ` +
      `firebase/firebase-admin import left for the loader to rewrite and those calls would reach ` +
      `LIVE Firebase. Rebuild with firebase and firebase-admin marked external. Warning only — ` +
      `nothing was blocked.`,
  );
  return lines;
}

// ─── Unsupported child runtimes (pure) ─────────────────────────────────────

/** Tokens that end one command and begin the next inside a shell string. */
const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '&']);

/** Command basenames that cannot evaluate Node loader hooks, → the runtime. */
const UNSUPPORTED_RUNTIME_BINARIES = new Map<string, string>([
  ['bun', 'bun'],
  ['bunx', 'bun'],
  ['deno', 'deno'],
]);

/** Strip directory and a Windows `.exe` suffix from a command token. */
function commandBasename(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.exe$/, '');
}

/**
 * Decide whether the child command starts a runtime that cannot intercept.
 *
 * Adopted decision 4. Detection is by COMMAND NAME, deliberately: argv[0] (and
 * any token that begins a new command after a shell operator), with leading
 * `KEY=VAL` assignments skipped and the path/`.exe` decoration stripped. That
 * is the honest 90% — `npm run dev` whose package script shells out to bun is
 * undetectable from here, and guessing would cost false positives on names
 * that merely start with the same letters (`bundle exec`).
 *
 * Returns the canonical runtime name (`bun` for `bunx` too) or null.
 */
export function detectUnsupportedRuntime(argv: readonly string[]): string | null {
  let atCommandStart = true;
  for (const token of argv) {
    if (atCommandStart && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (SHELL_OPERATORS.has(token)) {
      atCommandStart = true;
      continue;
    }
    if (atCommandStart) {
      const runtime = UNSUPPORTED_RUNTIME_BINARIES.get(commandBasename(token));
      if (runtime !== undefined) return runtime;
      atCommandStart = false;
    }
  }
  return null;
}

/**
 * The one warning. It has to say BOTH halves of what is lost: the loader swap
 * (interception itself) and the net guard (the socket backstop that would
 * otherwise catch the egress), because the guard is installed by the same
 * `--import`ed register module and is therefore just as absent.
 */
export function formatUnsupportedRuntimeWarning(runtime: string): string {
  return (
    `  ⚠ runtime: pyric interception is not supported under \`${runtime}\` — it does not evaluate ` +
    `Node loader hooks, so the child's firebase/firebase-admin imports will NOT be rewritten and ` +
    `may reach LIVE Firebase. The net-guard socket backstop also only applies under Node, so it ` +
    `will not catch that egress either. Run the command under \`node\` (or \`npx tsx\`) for the ` +
    `sandbox swap. Warning only — nothing was blocked.\n`
  );
}

// ─── Line prefixing (pure core) ────────────────────────────────────────────

/**
 * Incremental line prefixer: every child output line gets `[dev] `, partial
 * lines are buffered until their newline (or flush at stream end).
 */
export function createLinePrefixer(
  prefix: string,
  write: (line: string) => void,
): { push(chunk: string): void; flush(): void } {
  let buffer = '';
  return {
    push(chunk: string): void {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        write(`${prefix}${buffer.slice(0, nl)}\n`);
        buffer = buffer.slice(nl + 1);
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        write(`${prefix}${buffer}\n`);
        buffer = '';
      }
    },
  };
}

// ─── Spawn + lifecycle ─────────────────────────────────────────────────────

/** How long a signalled child may linger before SIGKILL. */
const FORCE_KILL_AFTER_MS = 2_000;

export interface SandboxChildHandle {
  exited: Promise<number>;
  signal(sig: NodeJS.Signals): void;
  child: ChildProcess;
}

export type DevChildHandle = SandboxChildHandle;

/**
 * Spawn the child with inherited stdin and `[dev]`-prefixed stdout/stderr.
 * In `--json` mode ALL child output goes to stderr — stdout carries exactly
 * the one machine line (the serve --json contract).
 */
export function spawnSandboxChild(
  plan: SandboxChildPlan,
  opts: { cwd: string; env: NodeJS.ProcessEnv; json: boolean },
): SandboxChildHandle {
  const parts = [...plan.argv];
  const env: NodeJS.ProcessEnv = { ...opts.env };

  // 1. Extract leading KEY=VAL assignments (e.g. PORT=8080 node server.js)
  while (parts.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0]!)) {
    const token = parts.shift()!;
    const eq = token.indexOf('=');
    const key = token.slice(0, eq);
    const val = token.slice(eq + 1);
    env[key] = val;
  }

  // 2. Check for discrete shell operators (&&, ||, |, ;) among top-level tokens
  const hasShellOperators = parts.some((token) => SHELL_OPERATORS.has(token));

  // (The unsupported-runtime warning for bun/deno is emitted by the launch
  // seam in serve.ts, alongside the interlock and pre-flight lines, so every
  // pre-spawn statement about the child prints in one block and in order.)

  const [command, ...args] = parts;
  let child: ChildProcess;
  if (hasShellOperators) {
    child = spawn(plan.label, [], {
      cwd: opts.cwd,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: true,
      detached: process.platform !== 'win32',
    });
  } else {
    child = spawn(command!, args, {
      cwd: opts.cwd,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
    });
  }

  const outTarget = opts.json ? process.stderr : process.stdout;
  const out = createLinePrefixer('[dev] ', (line) => outTarget.write(line));
  const err = createLinePrefixer('[dev] ', (line) => process.stderr.write(line));
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => out.push(chunk));
  child.stderr?.on('data', (chunk: string) => err.push(chunk));

  let signalled = false;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;
  const killTree = (signal: NodeJS.Signals): void => {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  };

  const exited = new Promise<number>((resolve) => {
    child.once('error', (e) => {
      process.stderr.write(`pyric sandbox: failed to run \`${plan.label}\`: ${e.message}\n`);
      resolve(1);
    });
    child.once('exit', (code, signal) => {
      out.flush();
      err.flush();
      if (forceTimer) clearTimeout(forceTimer);
      // User-initiated stop (Ctrl-C forwarded) is a clean shutdown → 0.
      if (signalled) resolve(0);
      else if (typeof code === 'number') resolve(code);
      else resolve(signal ? 1 : 0);
    });
  });

  return {
    exited,
    child,
    signal(sig: NodeJS.Signals): void {
      if (child.exitCode !== null || signalled) return;
      signalled = true;
      try {
        killTree(sig);
      } catch {
        return;
      }
      forceTimer = setTimeout(() => {
        try {
          killTree('SIGKILL');
        } catch {}
      }, FORCE_KILL_AFTER_MS);
      forceTimer.unref();
    },
  };
}

export const spawnDevChild = spawnSandboxChild;
