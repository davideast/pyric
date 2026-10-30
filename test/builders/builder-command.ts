/**
 * The command a builder run starts, inside the run's sandbox, in its app
 * directory. It is injectable: `round --builder claude` starts `claude -p`,
 * and `round --builder <script>` starts `node <script>`, which is how the
 * harness tests `round` end to end without a model (the fake builder in
 * `fixtures/fake-builder.mjs`).
 *
 * Either way the builder gets the same environment: where its brief, docs
 * and report are, the model and the cap it runs under, and, from the run
 * phase, `ANTHROPIC_BASE_URL`, the model channel's bridge. No builder gets
 * the token.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { builderSettingsProblems } from './builder-settings.ts';

export interface BuilderRun {
  /** The brief as text (`brief.md`) and as JSON (`brief.json`). */
  briefText: string;
  briefJson: string;
  /** pyric's docs from the same main commit: the site's Markdown and the conformance pages. */
  docsDir: string;
  /** Where the builder writes `report.json`. */
  reportFile: string;
  model: string;
  maxBudgetUsd: number;
}

export interface BuilderInvocation {
  command: string;
  args: string[];
  /** Everything the builder gets besides the recorder's and the channel's variables. Holds no secret. */
  env: Record<string, string>;
}

export interface Builder {
  /** What the run reports as its builder. */
  label: string;
  /**
   * Whether the builder talks to the model. Only then does the forwarder
   * hold the harness's token; for any other builder it refuses every request.
   */
  usesModel: boolean;
  /** Files and directories the sandbox must bind read-only for this builder. */
  readOnly: string[];
  invocation(run: BuilderRun): BuilderInvocation;
}

/** The environment every builder gets. */
export function builderEnvironment(run: BuilderRun): Record<string, string> {
  return {
    PYRIC_BUILDER_BRIEF: run.briefText,
    PYRIC_BUILDER_BRIEF_JSON: run.briefJson,
    PYRIC_BUILDER_DOCS: run.docsDir,
    PYRIC_BUILDER_REPORT: run.reportFile,
    PYRIC_BUILDER_MODEL: run.model,
    PYRIC_BUILDER_MAX_BUDGET_USD: String(run.maxBudgetUsd),
  };
}

/** The first message a model builder gets; its rules come from the appended system prompt. */
export function builderPrompt(run: BuilderRun): string {
  return [
    `Your brief is ${run.briefText}. Build the app it describes in the current directory, then attempt every action it says must be refused.`,
    `pyric's docs are in ${run.docsDir}. Write your report to ${run.reportFile}.`,
  ].join(' ');
}

export interface ClaudeBuilderOptions {
  /** The `claude` executable. */
  claude: string;
  /** The Claude Code permission file builders run with (`builder.settings.json`). */
  settings: string;
  /** The builder's rules (`.agents/skills/app-builder/SKILL.md`). */
  systemPrompt: string;
}

/**
 * The token from `claude setup-token`, in the harness's own environment, when
 * `round` is given no `--token-file`. It never enters the sandbox: only the
 * forwarder outside holds it.
 */
export const OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * What claude holds in the token's place. Set as `CLAUDE_CODE_OAUTH_TOKEN`,
 * it makes claude authenticate as a subscription: it sends the placeholder
 * as `Authorization: Bearer`, with the OAuth capability in `anthropic-beta`,
 * to `ANTHROPIC_BASE_URL` (https://code.claude.com/docs/en/authentication,
 * "Authentication precedence"; https://code.claude.com/docs/en/env-vars).
 * The forwarder swaps it for the real token. `ANTHROPIC_AUTH_TOKEN` would
 * send the same header without that capability, as a gateway's key.
 */
export const PLACEHOLDER_TOKEN = 'pyric-builder-placeholder-not-a-token';

/** Turns off Claude Code's own traffic besides the model API, which the sandbox would refuse anyway. */
const QUIET_CLAUDE: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
};

export function claudeBuilder(options: ClaudeBuilderOptions): Builder {
  const install = dirname(realpathSync(options.claude));
  return {
    label: 'claude',
    usesModel: true,
    readOnly: [install, options.settings, options.systemPrompt],
    invocation: (run) => ({
      command: realpathSync(options.claude),
      args: [
        '-p', builderPrompt(run),
        '--model', run.model,
        '--max-budget-usd', String(run.maxBudgetUsd),
        '--output-format', 'json',
        '--settings', options.settings,
        '--append-system-prompt-file', options.systemPrompt,
      ],
      env: { ...builderEnvironment(run), ...QUIET_CLAUDE, [OAUTH_TOKEN_ENV]: PLACEHOLDER_TOKEN },
    }),
  };
}

/** A scripted builder, run with `node`: no model, no spend. */
export function scriptBuilder(script: string): Builder {
  return {
    label: `script ${script}`,
    usesModel: false,
    readOnly: [],
    invocation: (run) => ({ command: 'node', args: [script], env: builderEnvironment(run) }),
  };
}

/**
 * What stops a claude builder from starting, said before anything runs:
 * claude, the settings file and its shape, and the skill. The token is
 * checked where it is read (`harness-token.ts`).
 */
export function claudeBuilderProblems(options: Partial<ClaudeBuilderOptions>): string[] {
  const problems: string[] = [];
  if (options.claude === undefined) problems.push('no claude on PATH');
  problems.push(...builderSettingsProblems(options.settings));
  if (options.systemPrompt === undefined || !existsSync(options.systemPrompt)) problems.push(`the app-builder skill file ${options.systemPrompt ?? '(none)'} does not exist`);
  return problems;
}
