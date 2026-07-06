/**
 * Interactive shell state machine that bridges xterm.js to a
 * just-bash session over the OPFS VFS. Handles the bits a raw
 * `terminal.onData` callback doesn't — line editing, command
 * history, tab completion, special keybindings, persistent cwd,
 * AbortController-backed Ctrl-C, color output, and the `/ai`
 * natural-language-to-command builtin.
 *
 * The class owns the input buffer + cursor position. xterm is a
 * dumb renderer here; every keystroke is interpreted ourselves and
 * we drive xterm's display through carefully placed ANSI sequences.
 */
import type { Terminal } from '@xterm/xterm';

import { runAi } from './ai';
import {
  BOLD,
  CLEAR_LINE_TO_END,
  CLEAR_SCREEN,
  colorize,
  CR,
  CRLF,
  DIM,
  FG_BRIGHT_GREEN,
  FG_CYAN,
  FG_GRAY,
  FG_RED,
  FG_YELLOW,
  moveCursorLeft,
  moveCursorRight,
  RESET,
} from './ansi';
import { createBashSession, type BashSession } from './bash-session';
import { complete } from './completion';
import { CommandHistory } from './history';

const ROOT_CWD = '/workspace';

const HELP_TEXT = [
  'pyric terminal — runs against the OPFS VFS via just-bash.',
  '',
  '  navigation        ↑/↓ history · Ctrl-R reverse search · Tab complete · Ctrl-L clear',
  '  line editing      Ctrl-A/E start/end · Ctrl-U/K kill to start/end · Ctrl-W delete word',
  '  control           Ctrl-C cancel input or running command · Ctrl-D EOF on empty line',
  '  builtins          :help · :clear · :history · :pwd · /ai <text>',
  '  ai assist         /ai how do I find files modified today',
];

/**
 * Tries to detect a `cd <path>` command that would change the user's
 * working directory and computes the new cwd. Supports the common
 * cases (lone `cd`, `cd a/b`, leading `cd && rest`); doesn't try to
 * follow shell control flow or subshells.
 */
function deriveNextCwd(currentCwd: string, line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Honor a leading `cd <arg>` segment. Anything after `&&` / `;`
  // executes in the parent shell context too — we still update.
  const firstSegment = trimmed.split(/\s*(?:&&|;|\|\|)\s*/, 1)[0]!;
  const cdMatch = firstSegment.match(/^cd(?:\s+(.+))?$/);
  if (!cdMatch) return null;
  const arg = cdMatch[1]?.trim();
  if (!arg || arg === '~') return ROOT_CWD;
  const parts = currentCwd.split('/').filter(Boolean);
  const target = arg.startsWith('/') ? arg : arg;
  const base = arg.startsWith('/') ? [] : parts;
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      base.pop();
      continue;
    }
    base.push(segment);
  }
  const next = `/${base.join('/')}`;
  return next === '/' ? '/' : next;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export class Shell {
  private term: Terminal;
  private session: BashSession;
  private history = new CommandHistory();

  private cwd = ROOT_CWD;
  private input = '';
  private cursor = 0;

  private historyIndex: number | null = null;
  private historyDraft = '';

  private busy = false;
  private runningAbort: AbortController | null = null;

  // Reverse search (Ctrl-R) state. Active when set; the input
  // buffer mirrors the matched history entry but is rendered with a
  // `(reverse-i-search)\``…`': prefix.
  private reverseSearch: { query: string; hitIndex: number | null } | null = null;

  constructor(term: Terminal, repoDir = ROOT_CWD) {
    this.term = term;
    this.session = createBashSession(repoDir);
  }

  /** Print the welcome banner and the first prompt. */
  start(): void {
    this.term.writeln(`${BOLD}pyric terminal${RESET} ${DIM}— /workspace via just-bash${RESET}`);
    this.term.writeln(`${DIM}type :help for hints, /ai <text> for an AI command${RESET}`);
    this.writePrompt();
  }

  /** Main entry from xterm's onData. */
  handleData(data: string): void {
    if (this.busy) {
      // Only Ctrl-C is honored while a command is running — every
      // other keystroke is dropped so the user's typing doesn't
      // leak into the next prompt.
      if (data === '\x03') this.runningAbort?.abort();
      return;
    }
    if (this.reverseSearch) {
      this.handleReverseSearch(data);
      return;
    }
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;
      const code = ch.charCodeAt(0);
      if (ch === '\x1b') {
        // Multi-byte escape — find the terminator. Most CSI sequences
        // end with a letter; we accept the common arrow / home / end /
        // delete forms.
        const rest = data.slice(i);
        const consumed = this.handleEscape(rest);
        if (consumed > 0) {
          i += consumed - 1;
          continue;
        }
      }
      if (code === 0x0d) {
        // Enter — strip pending CR/LF pair if present.
        if (data[i + 1] === '\n') i++;
        this.handleEnter();
        continue;
      }
      if (code === 0x0a) {
        this.handleEnter();
        continue;
      }
      if (code === 0x7f || code === 0x08) {
        this.handleBackspace();
        continue;
      }
      if (code === 0x09) {
        void this.handleTab();
        continue;
      }
      if (code === 0x03) {
        this.handleCtrlC();
        continue;
      }
      if (code === 0x04) {
        this.handleCtrlD();
        continue;
      }
      if (code === 0x0c) {
        this.handleCtrlL();
        continue;
      }
      if (code === 0x01) {
        this.moveCursorTo(0);
        continue;
      }
      if (code === 0x05) {
        this.moveCursorTo(this.input.length);
        continue;
      }
      if (code === 0x15) {
        this.replaceInput('', { keepCursor: false });
        continue;
      }
      if (code === 0x0b) {
        this.input = this.input.slice(0, this.cursor);
        this.renderInput();
        continue;
      }
      if (code === 0x17) {
        this.handleDeleteWord();
        continue;
      }
      if (code === 0x12) {
        this.reverseSearch = { query: '', hitIndex: null };
        this.renderReverseSearch();
        continue;
      }
      if (code < 0x20) {
        // unhandled control character — ignore
        continue;
      }
      // Printable / unicode character.
      this.insert(ch);
    }
  }

  /**
   * Handle one ANSI escape sequence beginning at the start of `rest`.
   * Returns the number of characters consumed (0 if not recognized).
   */
  private handleEscape(rest: string): number {
    if (rest.startsWith('\x1b[A')) {
      this.handleHistoryUp();
      return 3;
    }
    if (rest.startsWith('\x1b[B')) {
      this.handleHistoryDown();
      return 3;
    }
    if (rest.startsWith('\x1b[D')) {
      this.moveCursorBy(-1);
      return 3;
    }
    if (rest.startsWith('\x1b[C')) {
      this.moveCursorBy(1);
      return 3;
    }
    if (rest.startsWith('\x1b[H') || rest.startsWith('\x1b[1~')) {
      this.moveCursorTo(0);
      return rest.startsWith('\x1b[1~') ? 4 : 3;
    }
    if (rest.startsWith('\x1b[F') || rest.startsWith('\x1b[4~')) {
      this.moveCursorTo(this.input.length);
      return rest.startsWith('\x1b[4~') ? 4 : 3;
    }
    if (rest.startsWith('\x1b[3~')) {
      this.handleDelete();
      return 4;
    }
    // Unknown escape — consume until terminator letter or `~` so the
    // raw bytes don't pollute the input buffer.
    const match = rest.match(/^\x1b\[[0-9;?]*([A-Za-z~])/);
    return match ? match[0].length : 1;
  }

  private insert(ch: string): void {
    this.input = `${this.input.slice(0, this.cursor)}${ch}${this.input.slice(this.cursor)}`;
    this.cursor += ch.length;
    this.historyIndex = null;
    // Fast path: when inserting at the end, just write the char. Any
    // other position requires a full re-render to reflow.
    if (this.cursor === this.input.length) {
      this.term.write(ch);
    } else {
      this.renderInput();
    }
  }

  private handleBackspace(): void {
    if (this.cursor === 0) return;
    this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
    this.cursor -= 1;
    this.historyIndex = null;
    this.renderInput();
  }

  private handleDelete(): void {
    if (this.cursor >= this.input.length) return;
    this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
    this.historyIndex = null;
    this.renderInput();
  }

  private handleDeleteWord(): void {
    if (this.cursor === 0) return;
    let i = this.cursor;
    // Skip trailing whitespace.
    while (i > 0 && /\s/.test(this.input[i - 1]!)) i--;
    while (i > 0 && !/\s/.test(this.input[i - 1]!)) i--;
    this.input = this.input.slice(0, i) + this.input.slice(this.cursor);
    this.cursor = i;
    this.historyIndex = null;
    this.renderInput();
  }

  private moveCursorBy(delta: number): void {
    const next = Math.max(0, Math.min(this.input.length, this.cursor + delta));
    if (next === this.cursor) return;
    if (delta < 0) this.term.write(moveCursorLeft(this.cursor - next));
    else this.term.write(moveCursorRight(next - this.cursor));
    this.cursor = next;
  }

  private moveCursorTo(position: number): void {
    const next = Math.max(0, Math.min(this.input.length, position));
    if (next === this.cursor) return;
    if (next < this.cursor) this.term.write(moveCursorLeft(this.cursor - next));
    else this.term.write(moveCursorRight(next - this.cursor));
    this.cursor = next;
  }

  private replaceInput(value: string, opts: { keepCursor: boolean }): void {
    this.input = value;
    this.cursor = opts.keepCursor ? Math.min(this.cursor, value.length) : value.length;
    this.renderInput();
  }

  private handleEnter(): void {
    this.term.write(CRLF);
    const submitted = this.input;
    this.input = '';
    this.cursor = 0;
    this.historyIndex = null;
    this.historyDraft = '';
    if (!submitted.trim()) {
      this.writePrompt();
      return;
    }
    this.history.add(submitted);
    void this.runLine(submitted);
  }

  private handleCtrlC(): void {
    // No running command (we early-out at the top of handleData when
    // busy). Display ^C and reset the input line.
    this.term.write(`${colorize(FG_GRAY, '^C')}${CRLF}`);
    this.input = '';
    this.cursor = 0;
    this.historyIndex = null;
    this.writePrompt();
  }

  private handleCtrlD(): void {
    if (this.input.length > 0) {
      this.handleDelete();
      return;
    }
    this.term.write(`${colorize(FG_GRAY, 'exit')}${CRLF}`);
    // We can't actually exit the embedded terminal — emit a hint and
    // re-prompt. The user can close the tab instead.
    this.term.writeln(`${DIM}(can't exit an embedded shell — close the panel from the tab bar)${RESET}`);
    this.writePrompt();
  }

  private handleCtrlL(): void {
    this.term.write(CLEAR_SCREEN);
    this.writePrompt();
    this.term.write(this.input);
    if (this.cursor < this.input.length) {
      this.term.write(moveCursorLeft(this.input.length - this.cursor));
    }
  }

  private handleHistoryUp(): void {
    const size = this.history.size();
    if (size === 0) return;
    if (this.historyIndex === null) {
      this.historyDraft = this.input;
      this.historyIndex = size - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    } else {
      return;
    }
    const entry = this.history.at(this.historyIndex) ?? '';
    this.replaceInput(entry, { keepCursor: false });
  }

  private handleHistoryDown(): void {
    if (this.historyIndex === null) return;
    if (this.historyIndex >= this.history.size() - 1) {
      this.historyIndex = null;
      this.replaceInput(this.historyDraft, { keepCursor: false });
      this.historyDraft = '';
      return;
    }
    this.historyIndex += 1;
    const entry = this.history.at(this.historyIndex) ?? '';
    this.replaceInput(entry, { keepCursor: false });
  }

  private async handleTab(): Promise<void> {
    const left = this.input.slice(0, this.cursor);
    const right = this.input.slice(this.cursor);
    const result = await complete(left, this.cwd);
    if (!result) return;
    if (result.candidates.length > 0) {
      // Print candidates on a new line, then redraw the prompt + input.
      this.term.write(CRLF);
      this.printColumns(result.candidates);
      this.writePrompt();
      this.term.write(left);
      // Advance the buffer with whatever the helper extended us by.
      // The result.replacement is the full new last-token; we built
      // it from the existing prefix, so substituting at the lastSpace
      // gives us the extended buffer.
    }
    const lastSpace = left.search(/\S+$/);
    const tokenStart = lastSpace === -1 ? 0 : lastSpace;
    const newLeft = left.slice(0, tokenStart) + result.replacement;
    this.input = newLeft + right;
    this.cursor = newLeft.length;
    if (result.candidates.length === 0) {
      this.renderInput();
    } else {
      // We've already written the new prompt + left; just write the
      // extension delta then any right-of-cursor content.
      const delta = newLeft.slice(left.length);
      this.term.write(delta);
      if (right) {
        this.term.write(right);
        this.term.write(moveCursorLeft(right.length));
      }
    }
  }

  private printColumns(candidates: string[]): void {
    // Naive grid: stack into columns sized to the longest entry +2.
    const max = Math.max(...candidates.map((c) => c.length)) + 2;
    const cols = Math.max(1, Math.floor(this.term.cols / max));
    for (let i = 0; i < candidates.length; i++) {
      const cell = candidates[i]!.padEnd(max);
      this.term.write(colorize(FG_GRAY, cell));
      if ((i + 1) % cols === 0) this.term.write(CRLF);
    }
    if (candidates.length % cols !== 0) this.term.write(CRLF);
  }

  private handleReverseSearch(data: string): void {
    if (!this.reverseSearch) return;
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (code === 0x0d || code === 0x0a) {
        const hit =
          this.reverseSearch.hitIndex !== null
            ? this.history.at(this.reverseSearch.hitIndex) ?? ''
            : '';
        this.reverseSearch = null;
        // Land on the prompt with the matched entry, ready to edit/run.
        this.term.write(CRLF);
        this.input = hit;
        this.cursor = hit.length;
        this.writePrompt();
        this.term.write(hit);
        return;
      }
      if (code === 0x07 || code === 0x03 || code === 0x1b) {
        this.reverseSearch = null;
        this.term.write(CRLF);
        this.writePrompt();
        this.term.write(this.input);
        if (this.cursor < this.input.length) {
          this.term.write(moveCursorLeft(this.input.length - this.cursor));
        }
        return;
      }
      if (code === 0x12) {
        // Ctrl-R again — step further back.
        this.stepReverseSearch();
        continue;
      }
      if (code === 0x7f || code === 0x08) {
        this.reverseSearch.query = this.reverseSearch.query.slice(0, -1);
      } else if (code >= 0x20) {
        this.reverseSearch.query += ch;
      } else {
        continue;
      }
      this.reverseSearch.hitIndex = this.findReverseHit(this.reverseSearch.query, this.history.size() - 1);
      this.renderReverseSearch();
    }
  }

  private stepReverseSearch(): void {
    if (!this.reverseSearch) return;
    const startFrom =
      this.reverseSearch.hitIndex === null ? this.history.size() - 1 : this.reverseSearch.hitIndex - 1;
    this.reverseSearch.hitIndex = this.findReverseHit(this.reverseSearch.query, startFrom);
    this.renderReverseSearch();
  }

  private findReverseHit(query: string, from: number): number | null {
    if (!query) return null;
    for (let i = from; i >= 0; i--) {
      const entry = this.history.at(i) ?? '';
      if (entry.includes(query)) return i;
    }
    return null;
  }

  private renderReverseSearch(): void {
    if (!this.reverseSearch) return;
    const hit =
      this.reverseSearch.hitIndex !== null
        ? this.history.at(this.reverseSearch.hitIndex) ?? ''
        : '';
    const prefix = `${colorize(FG_GRAY, `(reverse-i-search)\``)}${this.reverseSearch.query}${colorize(FG_GRAY, `':`)} `;
    this.term.write(`${CR}${CLEAR_LINE_TO_END}${prefix}${hit}`);
  }

  private writePrompt(): void {
    this.term.write(this.prompt());
  }

  private prompt(): string {
    const cwd = colorize(FG_CYAN, this.cwd);
    const sigil = colorize(FG_BRIGHT_GREEN, '$');
    return `${cwd} ${sigil} `;
  }

  private renderInput(): void {
    this.term.write(`${CR}${CLEAR_LINE_TO_END}${this.prompt()}${this.input}`);
    if (this.cursor < this.input.length) {
      this.term.write(moveCursorLeft(this.input.length - this.cursor));
    }
  }

  // ─── Command execution ─────────────────────────────────────────────

  private async runLine(line: string): Promise<void> {
    if (await this.runBuiltin(line)) {
      this.writePrompt();
      return;
    }
    if (line.trim().startsWith('/ai ') || line.trim() === '/ai') {
      await this.runAiCommand(line);
      return;
    }
    await this.runBash(line);
  }

  private async runBuiltin(line: string): Promise<boolean> {
    const cmd = line.trim();
    if (cmd === ':help') {
      for (const row of HELP_TEXT) this.term.writeln(row);
      return true;
    }
    if (cmd === ':clear') {
      this.term.write(CLEAR_SCREEN);
      return true;
    }
    if (cmd === ':history') {
      const all = this.history.all();
      const total = all.length;
      const startIndex = Math.max(0, total - 50);
      for (let i = startIndex; i < total; i++) {
        const entry = all[i]!;
        const numeral = colorize(FG_GRAY, String(i + 1).padStart(4, ' '));
        this.term.writeln(`${numeral}  ${entry}`);
      }
      return true;
    }
    if (cmd === ':pwd') {
      this.term.writeln(this.cwd);
      return true;
    }
    return false;
  }

  private async runAiCommand(line: string): Promise<void> {
    const prompt = line.trim().slice('/ai'.length).trim();
    if (!prompt) {
      this.term.writeln(colorize(FG_GRAY, '/ai needs a natural-language request, e.g. /ai find tsx files'));
      this.writePrompt();
      return;
    }
    this.busy = true;
    this.runningAbort = new AbortController();
    this.term.write(`${colorize(FG_GRAY, '… asking the model')}${CRLF}`);
    try {
      const result = await runAi(prompt, {
        cwd: this.cwd,
        signal: this.runningAbort.signal,
        onChunk: (chunk) => {
          this.term.write(colorize(FG_GRAY, chunk));
        },
      });
      this.term.write(CRLF);
      if (!result.command || result.command.startsWith('#')) {
        if (result.command) {
          this.term.writeln(colorize(FG_YELLOW, result.command));
        } else {
          this.term.writeln(colorize(FG_YELLOW, '# model returned no command'));
        }
        this.writePrompt();
        return;
      }
      // Place the suggested command on the prompt line, ready to run.
      this.input = result.command;
      this.cursor = result.command.length;
      this.writePrompt();
      this.term.write(result.command);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.term.writeln(colorize(FG_RED, `/ai failed: ${message}`));
      this.writePrompt();
    } finally {
      this.busy = false;
      this.runningAbort = null;
    }
  }

  private async runBash(line: string): Promise<void> {
    this.busy = true;
    this.runningAbort = new AbortController();
    try {
      const result = await this.session.exec(`cd ${shellQuote(this.cwd)} && ${line}`, {
        signal: this.runningAbort.signal,
      });
      if (result.stdout) {
        this.writeWithCrlf(result.stdout);
      }
      if (result.stderr) {
        this.writeWithCrlf(result.stderr, FG_RED);
      }
      if (result.exitCode !== 0) {
        this.term.writeln(colorize(FG_YELLOW, `[exit ${result.exitCode}]`));
      }
      const nextCwd = deriveNextCwd(this.cwd, line);
      if (nextCwd) this.cwd = nextCwd;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.term.writeln(colorize(FG_RED, message));
    } finally {
      this.busy = false;
      this.runningAbort = null;
      this.writePrompt();
    }
  }

  /**
   * xterm.js treats LF alone as a line-feed without a CR — so output
   * containing bare `\n` (most program output) advances a row but
   * doesn't return to column 0, producing the staircase effect.
   * Normalise to CRLF on the way to the terminal.
   */
  private writeWithCrlf(text: string, color?: string): void {
    const normalised = text.replace(/\r?\n/g, CRLF);
    if (color) this.term.write(`${color}${normalised}${RESET}`);
    else this.term.write(normalised);
    if (!normalised.endsWith(CRLF)) this.term.write(CRLF);
  }
}
