/**
 * Antigravity's infrastructure signals: the phrases and JSON keys its stream-json
 * output carries when the account has no quota left, the model stream cut off
 * mid-run, or the agent answered a task through its own file tools instead of
 * the MCP surface under test.
 */
import type { CliSignals } from './signals.js';

export const ANTIGRAVITY_SIGNALS: CliSignals = {
  throttled: [/quota reached/i],
  interrupted: [/the stream was interrupted/i],
  builtinToolUse: [
    /"tool_name"\s*:\s*"view_file"/,
    /"tool_name"\s*:\s*"run_command"/,
    /"tool_name"\s*:\s*"list_dir"/,
    /"tool_name"\s*:\s*"grep_search"/,
    /"tool_name"\s*:\s*"find_by_name"/,
  ],
};

export default ANTIGRAVITY_SIGNALS;
