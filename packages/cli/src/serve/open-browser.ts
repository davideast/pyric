/**
 * Best-effort browser auto-open for `pyric dev`.
 *
 * The pyric sandbox is browser-resident: firestore/auth/persistence all run
 * IN the served page, so a dev who never opens it sees data ops silently
 * no-op. Opening the page on start (and the loud banner warning that pairs
 * with it) removes that surprise. Opening is ALWAYS best-effort — a failed
 * open must never fail `dev`; the URL is in the banner regardless.
 *
 * Auto-open is suppressed in the non-interactive paths where popping a
 * browser is wrong or useless: `--json` (the agent/CI stdout contract),
 * `--no-open`, no TTY (piped/redirected), and CI. `--no-open` is the manual
 * escape hatch for an interactive shell that still doesn't want it.
 */
import { execFile } from 'node:child_process';
import { platform } from 'node:os';

export interface AutoOpenContext {
  /** `--json` is on (stdout is the agent contract — never pop a browser). */
  json: boolean;
  /** `--no-open` was passed. */
  noOpen: boolean;
  /** stdout is a TTY (interactive). Piped/redirected → false. */
  isTTY: boolean;
  /** process.env, read for CI detection. */
  env: Record<string, string | undefined>;
}

/**
 * Pure decision: should `pyric dev` auto-open the browser? Factored out so
 * the gating logic is unit-testable without spawning anything. Open only when
 * interactive AND not explicitly suppressed AND not in CI.
 */
export function shouldAutoOpen(ctx: AutoOpenContext): boolean {
  if (ctx.json || ctx.noOpen || !ctx.isTTY) return false;
  if (ctx.env.CI) return false; // common CI marker; covers GH Actions et al.
  return true;
}

/** The platform command + leading args that open a URL in the default browser. */
function openCommand(url: string): { cmd: string; args: string[] } {
  switch (platform()) {
    case 'darwin':
      return { cmd: 'open', args: [url] };
    case 'win32':
      // `start` is a cmd builtin; the empty "" is the (ignored) window title
      // so a URL with `&` isn't mis-parsed as the title.
      return { cmd: 'cmd', args: ['/c', 'start', '""', url] };
    default:
      return { cmd: 'xdg-open', args: [url] };
  }
}

/**
 * Open `url` in the default browser, best-effort. Resolves whether or not the
 * open succeeded — callers must not let a missing `xdg-open` (headless Linux,
 * containers) take down the dev server. Never throws.
 */
export function openBrowser(url: string): Promise<void> {
  return new Promise((resolve) => {
    const { cmd, args } = openCommand(url);
    try {
      execFile(cmd, args, () => resolve()); // ignore exit code/stderr
    } catch {
      resolve(); // spawn itself threw (cmd missing) — swallow
    }
  });
}
