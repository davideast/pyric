/**
 * The `pyric dev` child runner — "one command, not two" (adoption design):
 * after the host is up, run the user's OWN dev command with the environment
 * activated so their unchanged firebase-admin/firebase imports resolve to the
 * pyric sandbox:
 *
 *   PYRIC_SANDBOX=remote:<serve url>          (the activator)
 *   NODE_OPTIONS += --import pyric-tools/register   (the substitution seam)
 *
 * Child-command precedence: explicit `pyric dev -- <cmd>` wins; else the
 * project package.json `dev` script (via the detected package manager); else
 * host-only (today's behavior). `--no-run` forces host-only; `--json`
 * defaults to host-only (an explicit `--` still wins — agents can opt in).
 *
 * Everything decision-shaped here is pure and exported for the unit suite;
 * only `spawnDevChild` touches the process table.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Child-command resolution (pure) ───────────────────────────────────────

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

/** Lockfile sniff, mirroring how init/vendor pick their install hints. */
export function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun';
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/** The project's `dev` script, or null (no package.json / no script). */
export function readDevScript(cwd: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    const dev = pkg.scripts?.dev;
    return typeof dev === 'string' && dev.trim().length > 0 ? dev : null;
  } catch {
    return null;
  }
}

export interface DevChildPlan {
  /** argv to spawn — argv[0] is the executable, no shell. */
  argv: string[];
  /** Human-readable command for the pre-spawn line. */
  label: string;
}

/**
 * Decide what (if anything) to run after the host is up.
 *
 * Matrix:
 *   --no-run                → null, always
 *   `-- <cmd>`              → that command (wins over everything else)
 *   --json (no `--`)        → null (machine mode defaults to host-only)
 *   package.json dev script → `<pm> run dev`
 *   none of the above       → null (host-only, today's behavior)
 *
 * A `dev` script that itself invokes `pyric dev` is treated as absent —
 * running it would recurse forever (pyric dev → npm run dev → pyric dev …).
 */
export function resolveDevChild(opts: {
  passthrough: string[];
  noRun: boolean;
  json: boolean;
  devScript: string | null;
  packageManager: PackageManager;
}): DevChildPlan | null {
  if (opts.noRun) return null;
  if (opts.passthrough.length > 0) {
    return { argv: [...opts.passthrough], label: opts.passthrough.join(' ') };
  }
  if (opts.json) return null;
  if (opts.devScript && !/(^|[\s;&|])pyric\s+dev\b/.test(opts.devScript)) {
    const label = `${opts.packageManager} run dev`;
    return { argv: [opts.packageManager, 'run', 'dev'], label };
  }
  return null;
}

// ─── Environment for the child (pure) ──────────────────────────────────────

/**
 * The absolute `file:` URL of the register module, resolved from
 * pyric-tools' OWN installed location — `import.meta.resolve` walks this
 * package's `exports` (self-reference), so it lands on the right file no
 * matter how the user's node_modules are laid out (hoisted, pnpm-isolated,
 * vendored). Fallback: relative to this compiled file (dist/cli/ →
 * dist/register/), for runtimes without a usable import.meta.resolve.
 */
export function registerModuleUrl(): string {
  try {
    const url = import.meta.resolve('pyric-tools/register');
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

export interface DevChildHandle {
  /** Resolves with the exit code to propagate once the child is gone. */
  exited: Promise<number>;
  /** Forward a signal (Ctrl-C / SIGTERM). Marks the exit as user-initiated
   *  so the propagated code is 0, and SIGKILLs a child that lingers. */
  signal(sig: NodeJS.Signals): void;
  child: ChildProcess;
}

/** How long a signalled child may linger before SIGKILL. */
const FORCE_KILL_AFTER_MS = 2_000;

/**
 * Spawn the child with inherited stdin and `[dev]`-prefixed stdout/stderr.
 * In `--json` mode ALL child output goes to stderr — stdout carries exactly
 * the one machine line (the serve --json contract).
 */
export function spawnDevChild(
  plan: DevChildPlan,
  opts: { cwd: string; env: NodeJS.ProcessEnv; json: boolean },
): DevChildHandle {
  const [command, ...args] = plan.argv;
  const child = spawn(command!, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  const outTarget = opts.json ? process.stderr : process.stdout;
  const out = createLinePrefixer('[dev] ', (line) => outTarget.write(line));
  const err = createLinePrefixer('[dev] ', (line) => process.stderr.write(line));
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => out.push(chunk));
  child.stderr?.on('data', (chunk: string) => err.push(chunk));

  let signalled = false;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;

  const exited = new Promise<number>((resolve) => {
    child.once('error', (e) => {
      process.stderr.write(`pyric dev: failed to run \`${plan.label}\`: ${e.message}\n`);
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
        child.kill(sig);
      } catch {
        return;
      }
      forceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, FORCE_KILL_AFTER_MS);
      forceTimer.unref();
    },
  };
}
