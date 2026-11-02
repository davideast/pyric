// The `codex exec` a session starts: its flags, its settings, and an
// environment that holds no login.
import { describe, expect, test } from 'bun:test';
import { sessionEnvironment, type AgentSession } from '../../agent.ts';
import { codexArgs, codexInvocation, MAX_REASONING_EFFORT, REASONING_EFFORTS } from './command.ts';

const SKILL = '# Factory builder\n\nYou build "one item" at a time.';

const SESSION: AgentSession = {
  command: '/opt/codex/bin/codex.js',
  cwd: '/run/app',
  runDir: '/run',
  briefDir: '/briefs/narrations',
  home: '/run/homes/builder-1',
  prompt: '-starts with a dash; build the next item',
  instructions: SKILL,
};

const BRIDGE = 'http://127.0.0.1:4321';

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
    const args = codexArgs(SESSION, BRIDGE);
    expect(args.slice(0, 7)).toEqual(['exec', '--json', '--strict-config', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox']);
    expect(args).toContain('--disable');
    expect(args[args.indexOf('-C') + 1]).toBe('/run/app');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-6.1-sol');
    expect(args).not.toContain('--sandbox');
  });

  test('ends with the prompt after --, so a prompt that starts with a dash is not a flag', () => {
    expect(codexArgs(SESSION, BRIDGE).slice(-2)).toEqual(['--', SESSION.prompt]);
  });

  test('points a custom provider at the bridge, sending no credential, and turns off what would reach past it', () => {
    const settings = settingsOf(codexArgs(SESSION, BRIDGE));
    expect(settings.get('model_provider')).toBe('"pyric"');
    expect(settings.get('model_providers.pyric.base_url')).toBe('"http://127.0.0.1:4321/backend-api/codex"');
    expect(settings.get('model_providers.pyric.wire_api')).toBe('"responses"');
    expect(settings.get('model_providers.pyric.requires_openai_auth')).toBe('false');
    expect(settings.get('model_providers.pyric.supports_websockets')).toBe('false');
    expect(settings.get('model_reasoning_effort')).toBe('"max"');
    expect(settings.get('web_search')).toBe('"disabled"');
    expect([...settings.keys()].some((key) => key.includes('env_key') || key.includes('bearer'))).toBe(false);
  });

  test('gives Codex the skill’s text as its developer instructions, as one TOML string', () => {
    const settings = settingsOf(codexArgs(SESSION, BRIDGE));
    expect(JSON.parse(settings.get('developer_instructions') ?? '""')).toBe(SKILL);
  });

  test('max is GPT-6.1 Sol’s deepest reasoning short of ultra, which also delegates', () => {
    expect(REASONING_EFFORTS.indexOf(MAX_REASONING_EFFORT)).toBe(REASONING_EFFORTS.length - 2);
  });
});

describe('codexInvocation', () => {
  test('adds a CODEX_HOME under the session’s HOME to the session’s environment, and nothing else', () => {
    const invocation = codexInvocation(SESSION, BRIDGE, sessionEnvironment(SESSION, { PATH: '/usr/bin' }));
    expect(invocation.command).toBe(SESSION.command);
    expect(invocation.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/run/homes/builder-1',
      CODEX_HOME: '/run/homes/builder-1/.codex',
      BRIEF_DIR: '/briefs/narrations',
      RUN_DIR: '/run',
      APP_DIR: '/run/app',
    });
  });
});
