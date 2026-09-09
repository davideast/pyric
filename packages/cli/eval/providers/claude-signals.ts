/**
 * Claude Code's infrastructure signals. It has no documented interrupted-stream
 * phrase of its own, so only the throttle and built-in-tool patterns are named
 * here; a generic empty-response rule in the classifier covers the rest.
 */
import type { CliSignals } from './signals.js';

export const CLAUDE_SIGNALS: CliSignals = {
  throttled: [/rate limit/i, /\b429\b/],
  interrupted: [],
  builtinToolUse: [
    /"name"\s*:\s*"Read"/,
    /"name"\s*:\s*"Bash"/,
    /"name"\s*:\s*"Glob"/,
    /"name"\s*:\s*"Grep"/,
  ],
};

export default CLAUDE_SIGNALS;
