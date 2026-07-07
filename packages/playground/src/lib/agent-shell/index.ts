/**
 * Agent shell — public entry. See `session.ts` for mechanics and
 * `man-pages.ts` for the on-demand docs the shell serves via `man`.
 */
export {
  createAgentShell,
  getAgentShell,
  resetAgentShell,
  rewriteLeadingTest,
  type AgentShell,
  type AgentShellExecOptions,
  type AgentShellResult,
} from './session';
export { AGENT_SHELL_BUILTINS, formatTestReport } from './builtins';
export { MAN_PAGES, MAN_TOPICS, type ManTopic } from './man-pages';
