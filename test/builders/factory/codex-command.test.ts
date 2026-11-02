// The `codex exec` a session starts: its flags, its settings, and an
// environment that holds no login.
import { describe, expect, test } from 'bun:test';
import { codexArgs, codexInvocation, FACTORY_MODEL, MAX_REASONING_EFFORT, REASONING_EFFORTS, type CodexSession } from './codex-command.ts';

const SESSION: CodexSession = {
  codex: '/opt/codex/bin/codex.js',
  cwd: '/run/app',
  home: '/run/homes/builder-1',
  model: FACTORY_MODEL,
  reasoningEffort: MAX_REASONING_EFFORT,
  prompt: '-starts with a dash; build the next item',
};

/** The `-c` settings, as a map. */
function settingsOf(args: readonly string[]): Map<string, string> {
  const settings = new Map<string, string>();
  args.forEach((arg, index) => {
    if (arg !== '-c') return;
    const [key, ...value] = (args[index + 1] ?? '').split('=');
    settings.set(key ?? '', value.join('='));
  });
  return settings;
}

describe('codexArgs', () => {
  test('runs codex exec printing JSON events, with no user config, rules or approvals, and its own sandbox bypassed', () => {
    const args = codexArgs(SESSION, 4321);
    expect(args.slice(0, 7)).toEqual(['exec', '--json', '--strict-config', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox']);
    expect(args).toContain('--disable');
    expect(args[args.indexOf('-C') + 1]).toBe('/run/app');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-6.1-sol');
    expect(args).not.toContain('--sandbox');
  });

  test('ends with the prompt after --, so a prompt that starts with a dash is not a flag', () => {
    const args = codexArgs(SESSION, 4321);
    expect(args.slice(-2)).toEqual(['--', SESSION.prompt]);
  });

  test('points a custom provider at the bridge, sending no credential, and turns off what would reach past it', () => {
    const settings = settingsOf(codexArgs(SESSION, 4321));
    expect(settings.get('model_provider')).toBe('"pyric"');
    expect(settings.get('model_providers.pyric.base_url')).toBe('"http://127.0.0.1:4321/backend-api/codex"');
    expect(settings.get('model_providers.pyric.wire_api')).toBe('"responses"');
    expect(settings.get('model_providers.pyric.requires_openai_auth')).toBe('false');
    expect(settings.get('model_providers.pyric.supports_websockets')).toBe('false');
    expect(settings.get('model_reasoning_effort')).toBe('"max"');
    expect(settings.get('web_search')).toBe('"disabled"');
    expect([...settings.keys()].some((key) => key.includes('env_key') || key.includes('bearer'))).toBe(false);
  });

  test('max is GPT-6.1 Sol’s deepest reasoning short of ultra, which also delegates', () => {
    expect(REASONING_EFFORTS.indexOf(MAX_REASONING_EFFORT)).toBe(REASONING_EFFORTS.length - 2);
  });
});

describe('codexInvocation', () => {
  test('gives Codex the seat’s HOME and a CODEX_HOME under it, on top of the base, and nothing else', () => {
    const invocation = codexInvocation(SESSION, 4321, { PATH: '/usr/bin' });
    expect(invocation.command).toBe(SESSION.codex);
    expect(invocation.env).toEqual({ PATH: '/usr/bin', HOME: '/run/homes/builder-1', CODEX_HOME: '/run/homes/builder-1/.codex' });
    expect(invocation.stdinFile).toBeNull();
  });

  test('sends a skill file on stdin', () => {
    const invocation = codexInvocation({ ...SESSION, skillFile: '/skills/factory-builder/SKILL.md' }, 1, {});
    expect(invocation.stdinFile).toBe('/skills/factory-builder/SKILL.md');
  });
});
