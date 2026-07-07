/**
 * Tight set of ANSI escape sequences the terminal layer uses.
 * Inlining here (instead of pulling a `chalk`-like dep) keeps the
 * bundle small and the call sites explicit about what's being
 * emitted.
 */

export const ESC = '\x1b';
export const CSI = `${ESC}[`;

export const RESET = `${CSI}0m`;
export const BOLD = `${CSI}1m`;
export const DIM = `${CSI}2m`;

// Foreground colors that play well with the playground's dark theme.
export const FG_RED = `${CSI}31m`;
export const FG_GREEN = `${CSI}32m`;
export const FG_YELLOW = `${CSI}33m`;
export const FG_BLUE = `${CSI}34m`;
export const FG_MAGENTA = `${CSI}35m`;
export const FG_CYAN = `${CSI}36m`;
export const FG_GRAY = `${CSI}90m`;
export const FG_BRIGHT_GREEN = `${CSI}92m`;

// Cursor / line ops we use during in-line editing.
export const CLEAR_LINE_TO_END = `${CSI}K`;
export const CLEAR_SCREEN = `${CSI}2J${CSI}H`;
export const CR = '\r';
export const LF = '\n';
export const CRLF = '\r\n';

export const moveCursorLeft = (n: number): string => (n > 0 ? `${CSI}${n}D` : '');
export const moveCursorRight = (n: number): string => (n > 0 ? `${CSI}${n}C` : '');

/** Wrap text in a color + reset. Inputs are concatenated; no parsing. */
export function colorize(color: string, text: string): string {
  return `${color}${text}${RESET}`;
}

/**
 * Strip ANSI control sequences from a string. Used when we need to
 * measure displayed length (cursor positioning math) without counting
 * escape bytes.
 */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}
