import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeBuilder, claudeBuilderProblems, OAUTH_TOKEN_ENV, scriptBuilder, type BuilderRun } from './builder-command.ts';
import { passedThrough } from './run-phase.ts';

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

  test('takes the OAuth token from the harness’s environment, never into a file, and quiets claude’s other traffic', () => {
    const invocation = claudeBuilder(files()).invocation(RUN);
    expect(invocation.passEnv).toEqual([OAUTH_TOKEN_ENV]);
    expect(Object.keys(invocation.env)).not.toContain(OAUTH_TOKEN_ENV);
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
  test('runs the script with node and the same builder environment, passing nothing through', () => {
    const invocation = scriptBuilder('/repo/fake-builder.mjs').invocation(RUN);
    expect(invocation).toMatchObject({ command: 'node', args: ['/repo/fake-builder.mjs'], passEnv: [] });
    expect(invocation.env).toMatchObject({ PYRIC_BUILDER_BRIEF: '/r/brief.md', PYRIC_BUILDER_MODEL: 'claude-haiku-test' });
  });
});

describe('passedThrough', () => {
  test('copies only the named variables that are set', () => {
    expect(passedThrough(['A', 'B'], { A: '1', C: '3' })).toEqual({ A: '1' });
  });
});
