/**
 * The command a factory session starts, inside the run's sandbox, in its
 * working directory. The agent runs with a config home of its own that
 * holds no credential, and every setting comes from the command line, with
 * `--ignore-user-config` and `--ignore-rules`, so nothing a session leaves
 * in its config home configures the next one.
 *
 * The model provider is `pyric`: a custom provider whose base URL is the
 * model channel's bridge on the sandbox's loopback, which sends no
 * credential (the provider's auth requirement off, no `env_key`). The forwarder
 * outside puts the credential on (`../../upstream-forwarder.ts`, with `policy.ts`). Websockets are off, so
 * every turn is one HTTP request the forwarder can check.
 *
 * The agent's own sandbox is bypassed (`--dangerously-bypass-approvals-and-sandbox`,
 * which the help reserves for "environments that are externally
 * sandboxed"): the bwrap sandbox is the boundary. Nested, the agent's sandbox
 * would cut the agent's commands off from loopback, where the app's dev
 * server, the harness browser and the bridge listen.
 */
import { join } from 'node:path';
import type { AgentSession, Invocation } from '../../agent.ts';
import { CODEX_BASE_PATH } from './policy.ts';

/** The configured model, by its slug in the agent's model list (`models_cache.json`). */
export const FACTORY_MODEL = 'gpt-6.1-sol';

/**
 * The reasoning efforts the configured model lists, lowest first. `max` is the
 * deepest reasoning; `ultra` is "maximum reasoning with automatic task
 * delegation", which also starts sub-agents.
 */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** The deepest reasoning without delegation, the factory's default. */
export const MAX_REASONING_EFFORT: ReasoningEffort = 'max';

/** The custom provider's name in the agent's config. */
export const CODEX_PROVIDER = 'pyric';

export interface CodexSettings {
  model: string;
  reasoningEffort: ReasoningEffort;
}

export const FACTORY_SETTINGS: CodexSettings = { model: FACTORY_MODEL, reasoningEffort: MAX_REASONING_EFFORT };

export const codexHomeOf = (home: string) => join(home, '.codex');

/** A TOML string; JSON's escapes are TOML's basic-string escapes. */
const tomlString = (value: string) => JSON.stringify(value);

/** `-c key=value` pairs, in order. */
function overrides(pairs: ReadonlyArray<readonly [string, string]>): string[] {
  return pairs.flatMap(([key, value]) => ['-c', `${key}=${value}`]);
}

/** The base URL the agent sends model requests to: the bridge, under the backend's own path, so the forwarder sends the path on as it is. */
export const providerBaseUrl = (bridgeUrl: string) => `${bridgeUrl}${CODEX_BASE_PATH}`;

/**
 * The settings that point the agent at the bridge, turn off what would reach
 * past it, and give it the role's skill as developer instructions, which
 * the agent adds to its own rather than replacing them.
 */
function settings(codex: CodexSettings, bridgeUrl: string, instructions: string): string[] {
  const provider = `model_providers.${CODEX_PROVIDER}`;
  return overrides([
    ['developer_instructions', tomlString(instructions)],
    ['model_reasoning_effort', tomlString(codex.reasoningEffort)],
    ['model_provider', tomlString(CODEX_PROVIDER)],
    [`${provider}.name`, tomlString('pyric model channel')],
    [`${provider}.base_url`, tomlString(providerBaseUrl(bridgeUrl))],
    [`${provider}.wire_api`, tomlString('responses')],
    [`${provider}.requires_openai_auth`, 'false'],
    [`${provider}.supports_websockets`, 'false'],
    ['web_search', tomlString('disabled')],
    ['check_for_update_on_startup', 'false'],
    ['analytics.enabled', 'false'],
    ['feedback.enabled', 'false'],
  ]);
}

/** The agent's command line for one session, printing its events as JSON lines on stdout, with the role's skill as developer instructions. */
export function codexArgs(session: AgentSession, bridgeUrl: string, codex: CodexSettings = FACTORY_SETTINGS): string[] {
  return [
    'exec',
    '--json',
    '--strict-config',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--disable', 'image_generation',
    '-C', session.cwd,
    '-m', codex.model,
    ...settings(codex, bridgeUrl, session.instructions),
    '--',
    session.prompt,
  ];
}

/** The command with the session's environment and a config home of its own under its HOME, holding no credential. */
export function codexInvocation(session: AgentSession, bridgeUrl: string, env: Record<string, string>, codex: CodexSettings = FACTORY_SETTINGS): Invocation {
  return {
    command: session.command,
    args: codexArgs(session, bridgeUrl, codex),
    env: { ...env, CODEX_HOME: codexHomeOf(session.home) },
  };
}
