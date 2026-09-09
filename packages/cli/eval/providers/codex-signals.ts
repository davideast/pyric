/**
 * Codex's infrastructure signals. Codex has no documented interrupted-stream
 * phrase of its own, so only the throttle and built-in-tool patterns are named
 * here; a generic empty-response rule in the classifier covers the rest.
 */
import type { CliSignals } from './signals.js';

export const CODEX_SIGNALS: CliSignals = {
  throttled: [/rate limit/i, /\b429\b/],
  interrupted: [],
  builtinToolUse: [/"command_execution"/, /"file_change"/],
};

export default CODEX_SIGNALS;
