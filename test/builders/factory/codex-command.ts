/**
 * The `codex exec` a factory session starts, inside the run's sandbox, in
 * its working directory. Codex runs with a CODEX_HOME of its own that holds
 * no login, and every setting comes from the command line, with
 * `--ignore-user-config` and `--ignore-rules`, so nothing a session leaves
 * in CODEX_HOME configures the next one.
 *
 * The model provider is `pyric`: a custom provider whose base URL is the
 * model channel's bridge on the sandbox's loopback, which sends no
 * credential (`requires_openai_auth = false`, no `env_key`). The forwarder
 * outside puts the login on (`codex-forwarder.ts`). Websockets are off, so
 * every turn is one HTTP request the forwarder can check.
 *
 * Codex's own sandbox is bypassed (`--dangerously-bypass-approvals-and-sandbox`,
 * which the help reserves for "environments that are externally
 * sandboxed"): the bwrap sandbox is the boundary. Nested, Codex's sandbox
 * would cut the agent's commands off from loopback, where the app's dev
 * server, the harness browser and the bridge listen.
 */
import { join } from 'node:path';

/** GPT-6.1 Sol, by its slug in Codex 0.164's model list (`models_cache.json`). */
export const FACTORY_MODEL = 'gpt-6.1-sol';

/**
 * The reasoning efforts GPT-6.1 Sol lists, lowest first. `max` is the
 * deepest reasoning; `ultra` is "maximum reasoning with automatic task
 * delegation", which also starts sub-agents.
 */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** The deepest reasoning without delegation, the factory's default. */
export const MAX_REASONING_EFFORT: ReasoningEffort = 'max';

/** The custom provider's name in Codex's config. */
export const CODEX_PROVIDER = 'pyric';

export interface CodexSession {
  /** The `codex` executable, as the sandbox sees it. */
  codex: string;
  /** The session's working directory: Codex's workspace root (`-C`). */
  cwd: string;
  /** The session's HOME, inside the run directory. CODEX_HOME is `<home>/.codex`. */
  home: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  /** The session's instructions. */
  prompt: string;
  /** A skill file, sent on stdin, which Codex appends to the prompt as a `<stdin>` block. */
  skillFile?: string;
}

export interface CodexInvocation {
  command: string;
  args: string[];
  /** Holds no secret. */
  env: Record<string, string>;
  /** What Codex reads on stdin: the skill file, or nothing. */
  stdinFile: string | null;
}

export const codexHomeOf = (session: Pick<CodexSession, 'home'>) => join(session.home, '.codex');

/** A TOML string; JSON's escapes are TOML's basic-string escapes. */
const tomlString = (value: string) => JSON.stringify(value);

/** `-c key=value` pairs, in order. */
function overrides(pairs: ReadonlyArray<readonly [string, string]>): string[] {
  return pairs.flatMap(([key, value]) => ['-c', `${key}=${value}`]);
}

/** The base URL Codex sends model requests to: the bridge, in plain HTTP on the sandbox's loopback. */
export const bridgeBaseUrl = (bridgePort: number) => `http://127.0.0.1:${bridgePort}/backend-api/codex`;

/** The settings that point Codex at the bridge and turn off what would reach past it. */
function settings(session: CodexSession, bridgePort: number): string[] {
  const provider = `model_providers.${CODEX_PROVIDER}`;
  return overrides([
    ['model_reasoning_effort', tomlString(session.reasoningEffort)],
    ['model_provider', tomlString(CODEX_PROVIDER)],
    [`${provider}.name`, tomlString('pyric codex channel')],
    [`${provider}.base_url`, tomlString(bridgeBaseUrl(bridgePort))],
    [`${provider}.wire_api`, tomlString('responses')],
    [`${provider}.requires_openai_auth`, 'false'],
    [`${provider}.supports_websockets`, 'false'],
    ['web_search', tomlString('disabled')],
    ['check_for_update_on_startup', 'false'],
    ['analytics.enabled', 'false'],
    ['feedback.enabled', 'false'],
  ]);
}

/** `codex exec` for one session, printing its events as JSON lines on stdout. */
export function codexArgs(session: CodexSession, bridgePort: number): string[] {
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
    '-m', session.model,
    ...settings(session, bridgePort),
    '--',
    session.prompt,
  ];
}

/** Codex's environment, built from nothing but `base` (PATH, LANG, TMPDIR and the recorder's variables). */
export function codexEnvironment(session: CodexSession, base: Record<string, string>): Record<string, string> {
  return { ...base, HOME: session.home, CODEX_HOME: codexHomeOf(session) };
}

export function codexInvocation(session: CodexSession, bridgePort: number, base: Record<string, string>): CodexInvocation {
  return {
    command: session.codex,
    args: codexArgs(session, bridgePort),
    env: codexEnvironment(session, base),
    stdinFile: session.skillFile ?? null,
  };
}
