import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { phaseEnvironment } from './builder-run.ts';
import { claudeBuilder, claudeBuilderProblems, OAUTH_TOKEN_ENV, PLACEHOLDER_TOKEN, scriptBuilder, type BuilderRun } from './builder-command.ts';
import { isStoppedAtLimit, phaseSchema } from './run-phase.ts';

const RUN: BuilderRun = { briefText: '/r/brief.md', briefJson: '/r/brief.json', docsDir: '/r/docs', reportFile: '/r/report.json', model: 'claude-haiku-test', maxBudgetUsd: 1.5 };

function files() {
  const dir = mkdtempSync(join(tmpdir(), 'builders-command-'));
  const claude = join(dir, 'claude');
  for (const file of [claude, join(dir, 'settings.json'), join(dir, 'SKILL.md')]) writeFileSync(file, '');
  return { claude, settings: join(dir, 'settings.json'), systemPrompt: join(dir, 'SKILL.md'), dir };
}

describe('claudeBuilder', () => {
  test('starts claude -p at the run’s model and cap, with the settings and the builder rules, printing JSON', () => {
    const options = files();
    const invocation = claudeBuilder(options).invocation(RUN);
    expect(invocation.command).toBe(options.claude);
    expect(invocation.args.slice(2)).toEqual([
      '--model', 'claude-haiku-test',
      '--max-budget-usd', '1.5',
      '--output-format', 'json',
      '--settings', options.settings,
      '--append-system-prompt-file', options.systemPrompt,
    ]);
    expect(invocation.args.slice(0, 2)).toEqual(['-p', expect.stringContaining('/r/brief.md')]);
  });

  test('holds a placeholder in the token’s place, talks to the model, and quiets claude’s other traffic', () => {
    const builder = claudeBuilder(files());
    const invocation = builder.invocation(RUN);
    expect(builder.usesModel).toBe(true);
    expect(invocation.env[OAUTH_TOKEN_ENV]).toBe(PLACEHOLDER_TOKEN);
    expect(Object.keys(invocation)).toEqual(['command', 'args', 'env']);
    expect(invocation.env).toMatchObject({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', PYRIC_BUILDER_REPORT: '/r/report.json', PYRIC_BUILDER_MAX_BUDGET_USD: '1.5' });
  });

  test('binds its install, settings and rules read-only', () => {
    const options = files();
    expect(claudeBuilder(options).readOnly).toEqual([options.dir, options.settings, options.systemPrompt]);
  });
});

describe('claudeBuilderProblems', () => {
  test('requires claude, the token, the settings file and the skill', () => {
    const options = files();
    expect(claudeBuilderProblems(options, { [OAUTH_TOKEN_ENV]: 'token' })).toEqual([]);
    expect(claudeBuilderProblems({ ...options, settings: '/nowhere/settings.json' }, {})).toEqual([
      `${OAUTH_TOKEN_ENV} is not set: run \`claude setup-token\` and export the token`,
      'the builder settings file /nowhere/settings.json does not exist',
    ]);
    expect(claudeBuilderProblems({}, { [OAUTH_TOKEN_ENV]: 'token' })).toEqual([
      'no claude on PATH',
      'the builder settings file (none) does not exist',
      'the app-builder skill file (none) does not exist',
    ]);
  });
});

describe('scriptBuilder', () => {
  test('runs the script with node and the same builder environment, with no model and no token', () => {
    const builder = scriptBuilder('/repo/fake-builder.mjs');
    const invocation = builder.invocation(RUN);
    expect(builder.usesModel).toBe(false);
    expect(invocation).toMatchObject({ command: 'node', args: ['/repo/fake-builder.mjs'] });
    expect(invocation.env).toMatchObject({ PYRIC_BUILDER_BRIEF: '/r/brief.md', PYRIC_BUILDER_MODEL: 'claude-haiku-test' });
    expect(Object.keys(invocation.env)).not.toContain(OAUTH_TOKEN_ENV);
  });
});

describe('what enters the sandbox', () => {
  const HARNESS_ENV = { PATH: '/bin', LANG: 'C.UTF-8', [OAUTH_TOKEN_ENV]: 'made-up-harness-token', ANTHROPIC_API_KEY: 'made-up-key', HOME: '/home/someone' };

  test('the run phase’s environment is built from nothing and carries no token', () => {
    const env = phaseEnvironment('/r/home', HARNESS_ENV);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH']);
    expect(JSON.stringify(env)).not.toContain('made-up');
  });

  test('phase.json has no field that could carry a value from the harness’s environment', () => {
    const phase = { ...claudeBuilder(files()).invocation(RUN), wallClockMs: 60_000, modelChannel: true, log: 'builder.log' };
    expect(phaseSchema.parse(phase)).toEqual(phase);
    expect(phaseSchema.safeParse({ ...phase, passEnv: [OAUTH_TOKEN_ENV] }).success).toBe(false);
  });
});

describe('isStoppedAtLimit', () => {
  test('tells a builder stopped at its cap from one that could not start', () => {
    expect(isStoppedAtLimit('claude -p x did not exit within 600s:\noutput')).toBe(true);
    expect(isStoppedAtLimit('spawn claude ENOENT')).toBe(false);
    expect(isStoppedAtLimit('ok\nlater: did not exit within 600s:')).toBe(false);
  });
});
