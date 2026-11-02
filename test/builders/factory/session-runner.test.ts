// The runner's layout, what each role is told, and one session in a real
// sandbox with a scripted Codex (`fixtures/fake-codex.ts`), a made-up login
// and a stand-in backend on loopback. Nothing reaches the network.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEvents } from './codex-events.ts';
import { roleSkill, rolePrompt } from './codex-roles.ts';
import { startFakeChatgpt, type FakeChatgpt } from './fake-chatgpt.ts';
import { fakeLogin } from './fake-login.ts';
import { BRIEF_DIR_ENV, codexInstall, layoutProblems, runConfiguredSession, runnerConfig, sessionPaths, type RunnerConfig } from './session-runner.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

/** A real sandbox's inventory walks every bound directory; with a cold file cache that passes bun's default 5 s. */
const SANDBOX_TEST_TIMEOUT_MS = 120_000;

const backends: FakeChatgpt[] = [];

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
});

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

describe('the role’s prompt and skill', () => {
  const options = { seat: 'builder-2', prompt: 'Take the next item.', deadline: '2026-11-02T08:00:00.000Z' };
  const dirs = { briefDir: '/briefs/narrations', runDir: '/f/run', appDir: '/f/run/app' };

  test('names the role, seat and the three directories, the work-list rule and the run’s end, then the supervisor’s prompt', () => {
    const prompt = rolePrompt('builder', options, dirs);
    expect(prompt).toContain('You are the factory\'s builder, in seat builder-2. Your instructions are the factory-builder skill.');
    expect(prompt).toContain('$BRIEF_DIR is /briefs/narrations (read-only), $RUN_DIR is /f/run and $APP_DIR is /f/run/app');
    expect(prompt).toContain('temporary file beside it, then renaming that file over /f/run/work-list.json');
    expect(prompt).toContain('2026-11-02T08:00:00.000Z');
    expect(prompt.endsWith('Take the next item.')).toBe(true);
  });

  test('takes the role’s skill from the checkout, and fails naming the path when it is missing', () => {
    const skills = mkdtempSync(join(tmpdir(), 'factory-skills-'));
    mkdirSync(join(skills, 'factory-triage'));
    writeFileSync(join(skills, 'factory-triage', 'SKILL.md'), '');
    expect(roleSkill('triage', skills)).toBe(join(skills, 'factory-triage', 'SKILL.md'));
    expect(() => roleSkill('lead', skills)).toThrow(`no skill for the lead role at ${join(skills, 'factory-lead', 'SKILL.md')}`);
  });

  test('needs the brief directory named', () => {
    expect(() => runnerConfig('lead', {})).toThrow(`no brief directory: set ${BRIEF_DIR_ENV}`);
  });
});

/** A run directory with its app and shared files, a brief outside it, and a config with a scripted Codex. */
async function layout(): Promise<{ runDir: string; appDir: string; config: RunnerConfig; backend: FakeChatgpt }> {
  const runDir = mkdtempSync(join(tmpdir(), 'factory-run-'));
  const appDir = join(runDir, 'app');
  mkdirSync(appDir);
  for (const name of ['work-list.json', 'progress.md', 'latest-check.json']) writeFileSync(join(runDir, name), '');
  const briefDir = mkdtempSync(join(tmpdir(), 'factory-brief-'));
  writeFileSync(join(briefDir, 'BRIEF.md'), 'what the app should do by morning');
  const skillFile = join(briefDir, 'SKILL.md');
  writeFileSync(skillFile, 'the lead’s skill');
  const backend = await startFakeChatgpt();
  backends.push(backend);
  const login = fakeLogin();
  const config: RunnerConfig = {
    briefDir,
    codex: { codex: join(FIXTURES, 'fake-codex.ts'), packageDir: FIXTURES },
    skillFile,
    login: () => ({ ok: true, login }),
    upstream: { host: '127.0.0.1', port: backend.port, tls: false },
  };
  return { runDir, appDir, config, backend };
}

describe('layoutProblems', () => {
  test('refuses a brief inside the run directory, an app outside it, a missing brief and a login it can’t read', async () => {
    const { runDir, appDir, config } = await layout();
    const paths = sessionPaths(runDir, 'lead', 'stamp');
    expect(layoutProblems({ runDir, appDir }, config, paths)).toEqual([]);
    const inside = { ...config, briefDir: join(runDir, 'brief') };
    mkdirSync(inside.briefDir);
    expect(layoutProblems({ runDir, appDir }, inside, paths)).toEqual([`the brief directory ${inside.briefDir} is inside the run directory, which sessions can write`]);
    expect(layoutProblems({ runDir, appDir: '/elsewhere/app' }, config, paths)).toEqual(['the app directory /elsewhere/app is outside the run directory, so sessions could not write it']);
    const missing = { ...config, briefDir: join(tmpdir(), 'no-such-brief'), login: () => ({ ok: false as const, problem: 'the Codex login /x does not exist' }) };
    expect(layoutProblems({ runDir, appDir }, missing, paths)).toEqual(['the Codex login /x does not exist', `the brief directory ${missing.briefDir} does not exist`]);
  });
});

describe('a session in its sandbox', () => {
  test('sees $BRIEF_DIR, $RUN_DIR and $APP_DIR, reads the brief, writes the run and the app, and can’t write the brief', async () => {
    const { runDir, appDir, config, backend } = await layout();
    const result = await runConfiguredSession('lead', {
      seat: 'lead',
      prompt: 'Plan the first items.',
      runDir,
      appDir,
      files: { workList: join(runDir, 'work-list.json'), progress: join(runDir, 'progress.md'), latestCheck: join(runDir, 'latest-check.json') },
      deadline: new Date(Date.now() + 60_000).toISOString(),
      remainingMs: 60_000,
      signal: new AbortController().signal,
    }, config);
    expect(result).toMatchObject({ exitCode: 0, endedBy: 'exit' });
    const events = parseEvents(readFileSync(result.logPath, 'utf8'));
    expect(events.find((event) => event.type === 'fake.dirs')).toMatchObject({
      brief: config.briefDir, run: runDir, app: appDir,
      readBrief: 'ok', writeRun: 'ok', writeApp: 'ok', writeBrief: 'EROFS',
    });
    expect(events.find((event) => event.type === 'fake.instructions')?.text).toBe('the lead’s skill');
    expect(readFileSync(join(runDir, 'from-session.txt'), 'utf8')).toBe('written in the session');
    expect(existsSync(join(config.briefDir, 'from-session.txt'))).toBe(false);
    expect(backend.received).toHaveLength(1);
  }, SANDBOX_TEST_TIMEOUT_MS);
});
