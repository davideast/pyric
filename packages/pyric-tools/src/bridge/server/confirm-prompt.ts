/**
 * Terminal prompt rendering + single-key input for prod-mode
 * confirmation.
 *
 * The prompt opens `/dev/tty` directly — not stdin — so that:
 *
 *  (a) An inherited / redirected stdin can't feed the prompt fake
 *      "y" bytes. The controlling tty is what the human at the
 *      keyboard talks to. A same-user malicious process can't
 *      write to another process's controlling tty without elevated
 *      privilege (this is what makes confirmation a real defense).
 *
 *  (b) The bridge can run with its stdin closed / piped (e.g.,
 *      launched from a Vite plugin, an Electron app, or any other
 *      host) while still being able to ask the user for approval.
 *
 * TTY presence detection (`hasInteractiveTTY`) is exported so the
 * standalone server can refuse to start prod mode in headless
 * environments.
 */

import { openSync, closeSync } from 'node:fs';
import { isatty } from 'node:tty';
import { ReadStream, WriteStream } from 'node:tty';

export interface PromptRequest {
  tool: string;
  args: Record<string, unknown>;
  project: string;
  policy: 'always' | 'session';
  /** Optional pretty diff lines (current vs proposed). v1: not populated. */
  diff?: string[];
  /** Optional auth context highlight (rule-eval as user X). */
  asUser?: string | null;
  /** Iso timestamp for header. Default: now. */
  now?: () => Date;
  /** Color output. Default: auto-detect from tty. */
  useColor?: boolean;
}

export type PromptKey =
  | 'approve'      // y
  | 'deny'         // n
  | 'approve-tool' // a (session whitelist)
  | 'deny-all'    // D (session-wide kill switch)
  | 'timeout'
  | 'unknown';

export interface PromptIO {
  /** Whether a real interactive tty is available right now. */
  isInteractive(): boolean;
  /** Print prompt text to the tty (or fake). */
  write(text: string): void;
  /**
   * Read a single key from the tty. Returns the parsed PromptKey,
   * or 'timeout' if the deadline expires, or 'unknown' for any
   * other key (so the caller can re-prompt).
   */
  readKey(timeoutMs: number): Promise<PromptKey>;
  /** Restore tty state / close fds. Safe to call multiple times. */
  close(): void;
}

// ── Interactive (real /dev/tty) implementation ────────────────────────

/** Returns true iff `/dev/tty` exists and is a real TTY. */
export function hasInteractiveTTY(): boolean {
  let fd: number | null = null;
  try {
    fd = openSync('/dev/tty', 'r+');
    return isatty(fd);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Open `/dev/tty` and return a PromptIO that reads/writes it in raw
 * mode. The caller is responsible for `close()` when done.
 *
 * Throws if /dev/tty isn't available — caller must check with
 * `hasInteractiveTTY()` first.
 */
export function openTtyPromptIO(): PromptIO {
  const fd = openSync('/dev/tty', 'r+');
  const reader = new ReadStream(fd);
  const writer = new WriteStream(fd);
  reader.setRawMode(true);
  reader.resume();

  return {
    isInteractive: () => true,
    write(text: string) {
      writer.write(text);
    },
    readKey(timeoutMs: number): Promise<PromptKey> {
      return new Promise<PromptKey>((resolve) => {
        let done = false;
        const finish = (key: PromptKey) => {
          if (done) return;
          done = true;
          reader.off('data', onData);
          clearTimeout(timer);
          resolve(key);
        };
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        const onData = (chunk: Buffer) => {
          const byte = chunk[0];
          if (byte === undefined) return;
          // Ctrl-C aborts as deny.
          if (byte === 0x03) {
            finish('deny');
            return;
          }
          finish(parseKey(String.fromCharCode(byte)));
        };
        reader.on('data', onData);
      });
    },
    close() {
      try {
        reader.setRawMode(false);
        reader.pause();
        reader.destroy();
        writer.destroy();
        closeSync(fd);
      } catch {
        // best-effort
      }
    },
  };
}

/** Map a raw single character to a semantic PromptKey. */
export function parseKey(ch: string): PromptKey {
  switch (ch) {
    case 'y':
    case 'Y':
      return 'approve';
    case 'n':
    case 'N':
      return 'deny';
    case 'a':
      return 'approve-tool';
    case 'D':
      return 'deny-all';
    default:
      return 'unknown';
  }
}

// ── Prompt rendering ──────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const SEP = '─────────────────────────────────────────────────────────';

function color(text: string, ansi: string, useColor: boolean): string {
  return useColor ? `${ansi}${text}${RESET}` : text;
}

/**
 * Build the multi-line prompt string. Pure function — no I/O —
 * so it's straightforward to unit-test.
 */
export function renderPrompt(req: PromptRequest): string {
  const useColor = req.useColor ?? true;
  const now = (req.now ?? (() => new Date()))();
  const hh = now.getUTCHours().toString().padStart(2, '0');
  const mm = now.getUTCMinutes().toString().padStart(2, '0');
  const ss = now.getUTCSeconds().toString().padStart(2, '0');
  const time = `${hh}:${mm}:${ss}`;

  const isDelete = req.tool.includes('delete') || req.tool.includes('remove');
  const headerIcon = isDelete ? '⛔' : '⚠';
  const headerColor = isDelete ? RED : YELLOW;

  const argsBlock = formatArgs(req.args);

  const lines: string[] = [];
  lines.push('');
  lines.push(color(SEP, headerColor, useColor));
  lines.push(
    color(`[pyric prod ${time}]  ${headerIcon}  CONFIRM TOOL CALL`, BOLD + headerColor, useColor),
  );
  lines.push(color(SEP, headerColor, useColor));
  lines.push(`Project:  ${color(req.project, CYAN, useColor)}`);
  lines.push(`Tool:     ${color(req.tool, BOLD, useColor)}`);
  if (req.asUser) {
    lines.push(`As user:  ${color(req.asUser, YELLOW, useColor)}`);
  }
  lines.push(`Args:     ${argsBlock}`);
  if (req.diff && req.diff.length > 0) {
    lines.push(`Diff:`);
    for (const dline of req.diff) lines.push(`          ${dline}`);
  }
  lines.push(color(SEP, headerColor, useColor));
  lines.push(`  ${color('[y]', BOLD, useColor)}   approve this call`);
  lines.push(
    `  ${color('[n]', BOLD, useColor)}   deny this call                          ${color('(default after timeout)', DIM, useColor)}`,
  );
  if (req.policy === 'always') {
    lines.push(
      `  ${color('[a]', BOLD, useColor)}   approve all \`${req.tool}\` for this session`,
    );
  }
  lines.push(`  ${color('[D]', BOLD + RED, useColor)}   DENY everything for the rest of this session`);
  lines.push(color(SEP, headerColor, useColor));
  lines.push(`> `);
  return lines.join('\n');
}

/**
 * Pretty-print args. Truncates at 2KB (showing `…` and a hint). The
 * intent is "enough to recognise the call," not the full payload —
 * for that, the audit log has the unmodified args.
 */
export function formatArgs(args: Record<string, unknown>): string {
  const MAX_BYTES = 2048;
  const indent = ' '.repeat(10); // align under "Args:     "
  let text: string;
  try {
    text = JSON.stringify(args, null, 2);
  } catch {
    text = String(args);
  }
  if (text.length > MAX_BYTES) {
    text = text.slice(0, MAX_BYTES) + '\n... (truncated; full args in audit log)';
  }
  // Re-indent every line except the first by 10 spaces so output
  // aligns under the "Args:     " label.
  const lines = text.split('\n');
  const head = lines[0] ?? '';
  const rest = lines.slice(1).map((l) => indent + l);
  return [head, ...rest].join('\n');
}
