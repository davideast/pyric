// The runner's layout and what each role is told. The runner's session
// itself is covered by codex-session.test.ts; with a sandbox it needs bwrap
// and the real login, so no test starts it.
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roleSkill, rolePrompt } from './codex-roles.ts';
import { codexInstall, sessionPaths } from './session-runner.ts';

describe('sessionPaths', () => {
  test('keeps the seat’s HOME, logs, phase and socket in the run, and the channel record beside it', () => {
    const paths = sessionPaths('/f/run', 'builder-1', '2026-11-02T00-00-00-000Z');
    expect(paths).toEqual({
      home: '/f/run/homes/builder-1',
      log: '/f/run/logs/builder-1-2026-11-02T00-00-00-000Z.jsonl',
      networkLog: '/f/run/logs/builder-1-2026-11-02T00-00-00-000Z.network.jsonl',
      phaseFile: '/f/run/logs/builder-1-2026-11-02T00-00-00-000Z.phase.json',
      socket: '/f/run/builder-1-2026-11-02T00-00-00-000Z.sock',
      channelRecord: '/f/run.codex-channel/builder-1.jsonl',
    });
  });
});

describe('codexInstall', () => {
  test('finds codex on PATH and binds its package directory', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'factory-install-'));
    const bin = join(prefix, 'node_modules', '@openai', 'codex', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'codex.js'), '');
    chmodSync(join(bin, 'codex.js'), 0o755);
    const pathDir = join(prefix, 'bin');
    mkdirSync(pathDir);
    symlinkSync(join(bin, 'codex.js'), join(pathDir, 'codex'));
    const found = codexInstall({ PATH: `/nonexistent:${pathDir}` });
    expect(found).toEqual({ codex: join(bin, 'codex.js'), packageDir: join(prefix, 'node_modules', '@openai', 'codex') });
    expect(() => codexInstall({ PATH: '/nonexistent' })).toThrow('no codex on PATH');
  });
});

describe('the role’s prompt', () => {
  const options = { seat: 'builder-2', prompt: 'Take the next item.', appDir: '/f/run/app', files: { workList: '/f/run/work-list.json', progress: '/f/run/progress.md', latestCheck: '/f/run/latest-check.json' }, deadline: '2026-11-02T08:00:00.000Z' };

  test('says the role and seat, the shared files and the run’s end, then the supervisor’s prompt', () => {
    const prompt = rolePrompt('builder', options);
    expect(prompt.startsWith('You are a builder')).toBe(true);
    expect(prompt).toContain('Your seat is builder-2.');
    for (const file of Object.values(options.files)) expect(prompt).toContain(file);
    expect(prompt).toContain('2026-11-02T08:00:00.000Z');
    expect(prompt).toContain('temporary file beside it, then renaming that file over /f/run/work-list.json');
    expect(prompt.endsWith('Take the next item.')).toBe(true);
  });

  test('takes a role’s skill only when the repo has one', () => {
    const skills = mkdtempSync(join(tmpdir(), 'factory-skills-'));
    mkdirSync(join(skills, 'factory-triage'));
    writeFileSync(join(skills, 'factory-triage', 'SKILL.md'), '');
    expect(roleSkill('triage', skills)).toBe(join(skills, 'factory-triage', 'SKILL.md'));
    expect(roleSkill('lead', skills)).toBeUndefined();
  });
});
