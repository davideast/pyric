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

const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '&']);

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

  // 3. Warn if runtime is bun or deno
  if (parts.length > 0 && (parts[0] === 'bun' || parts[0] === 'deno')) {
    const runner = parts[0];
    const target = opts.json ? process.stderr : process.stdout;
    target.write(
      `  ⚠ ${runner} detected: pyric intercepts Firebase imports via Node.js module loader hooks (NODE_OPTIONS="--import ..."). ` +
        `${runner} does not evaluate Node loader hooks — SDK calls in this process will not reach the pyric sandbox. ` +
        `Use \`node\` (or \`npx tsx\`) to run with the sandbox swap.\n`,
    );
  }

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
