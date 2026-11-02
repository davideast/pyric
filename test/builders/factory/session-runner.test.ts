// The runner's layout, what each role is told, the binds it refuses, and
// sessions in a real sandbox with the made-up agent
// (`fixtures/fake-agent.ts`) and a stand-in upstream on loopback. Nothing
// reaches the network.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { npmCacheDir } from '../app-install.ts';
import { playwrightBrowsersPath, PLAYWRIGHT_CLIENT_ENV } from '../browser-server.ts';
import { toolchainDirs } from '../namespace.ts';
import { FAKE_MEDIA } from './app-start.ts';
import { fakeAgent } from './fixtures/fake-agent.ts';
import { startFakeUpstream, type FakeUpstream } from './fixtures/fake-upstream.ts';
import { hostDirOf } from './host-files.ts';
import { ONLINE_INIT_ENV } from './online-init.ts';
import { roleSkill, rolePrompt } from './roles.ts';
import { bindProblems, layoutProblems, runConfiguredSession, runnerConfig, sessionPaths, type RunnerConfig } from './session-runner.ts';
import type { SessionOptions } from './session.ts';

/** A real sandbox's inventory walks every bound directory; with a cold file cache that passes bun's default 5 s. */
const SANDBOX_TEST_TIMEOUT_MS = 120_000;

const upstreams: FakeUpstream[] = [];

afterEach(async () => {
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
});

describe('sessionPaths', () => {
  test('keeps the seat’s HOME and network record in the run, and its log, sandbox directory and channel record in the host directory', () => {
    expect(sessionPaths('/f/run', 'builder-1', '2026-11-02T00-00-00-000Z')).toEqual({
      home: '/f/run/homes/builder-1',
      log: '/f/run.host/logs/builder-1-2026-11-02T00-00-00-000Z.jsonl',
      networkLog: '/f/run/logs/builder-1-2026-11-02T00-00-00-000Z.network.jsonl',
      sandboxDir: '/f/run.host/s/builder-1-2026-11-02T00-00-00-000Z',
      channelRecord: '/f/run.host/channel/builder-1.jsonl',
    });
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

  test('needs an agent the registry knows', () => {
    expect(() => runnerConfig('lead', { agent: 'no-such-agent' })).toThrow('no agent adapter named "no-such-agent"');
  });
});

describe('bindProblems', () => {
  test('refuses a bind that contains the home directory or reaches the agent’s credential directory, either way', () => {
    const agent = fakeAgent({ credentialDirs: ['/h/me/.agent'] });
    const config = { agent, home: '/h/me' };
    expect(bindProblems(['/h/me/tools/agent', '/opt/agent'], config)).toEqual([]);
    expect(bindProblems(['/h/me'], config)).toEqual(['the bind /h/me contains the home directory /h/me', 'the bind /h/me reaches the agent\'s credential directory']);
    expect(bindProblems(['/h'], config)).toHaveLength(2);
    expect(bindProblems(['/h/me/.agent/bin'], config)).toEqual(['the bind /h/me/.agent/bin reaches the agent\'s credential directory']);
  });

  test('sees through a link to the home directory or the credential directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-binds-'));
    const home = join(root, 'home');
    const secret = join(home, '.agent');
    mkdirSync(secret, { recursive: true });
    const toHome = join(root, 'to-home');
    const toSecret = join(root, 'to-secret');
    symlinkSync(home, toHome);
    symlinkSync(secret, toSecret);
    const config = { agent: fakeAgent({ credentialDirs: [secret] }), home };
    expect(bindProblems([toHome], config)).toContain(`the bind ${toHome} contains the home directory ${home}`);
    expect(bindProblems([toSecret], config)).toEqual([`the bind ${toSecret} reaches the agent's credential directory`]);
  });
});

interface Layout {
  options: SessionOptions;
  config: RunnerConfig;
  upstream: FakeUpstream;
}

/** A run directory with its app and shared files, a brief outside it, and a config with the made-up agent. */
async function layout(): Promise<Layout> {
  // Short, under /tmp: the forwarder's socket path must fit in 107 bytes.
  const runDir = mkdtempSync(join('/tmp', 'fr-'));
  const appDir = join(runDir, 'app');
  mkdirSync(appDir);
  for (const name of ['work-list.json', 'progress.md', 'latest-check.json']) writeFileSync(join(runDir, name), '');
  const briefDir = mkdtempSync(join(tmpdir(), 'factory-brief-'));
  writeFileSync(join(briefDir, 'BRIEF.md'), 'what the app should do by morning');
  const skillFile = join(mkdtempSync(join(tmpdir(), 'factory-skill-')), 'SKILL.md');
  writeFileSync(skillFile, 'the lead’s skill');
  const upstream = await startFakeUpstream();
  upstreams.push(upstream);
  const agent = fakeAgent();
  const options: SessionOptions = {
    seat: 'lead',
    prompt: 'Plan the first items.',
    runDir,
    appDir,
    agent: 'fake',
    briefDir,
    files: { workList: join(runDir, 'work-list.json'), progress: join(runDir, 'progress.md'), latestCheck: join(runDir, 'latest-check.json') },
    deadline: new Date(Date.now() + 60_000).toISOString(),
    remainingMs: 60_000,
    signal: new AbortController().signal,
  };
  const config: RunnerConfig = {
    agent,
    install: agent.install(process.env),
    skillFile,
    credential: () => agent.readCredential(),
    upstream: { host: '127.0.0.1', port: upstream.port, tls: false },
    home: '/nonexistent-home',
  };
  return { options, config, upstream };
}

describe('layoutProblems', () => {
  test('refuses a brief inside the run directory, an app outside it, a missing brief and a credential it can’t read', async () => {
    const { options, config } = await layout();
    const paths = sessionPaths(options.runDir, 'lead', 'stamp');
    expect(layoutProblems(options, config, paths)).toEqual([]);
    const inside = join(options.runDir, 'brief');
    mkdirSync(inside);
    expect(layoutProblems({ ...options, briefDir: inside }, config, paths)).toEqual([`the brief directory ${inside} is inside the run directory, which sessions can write`]);
    expect(layoutProblems({ ...options, appDir: '/elsewhere/app' }, config, paths)).toEqual(['the app directory /elsewhere/app is outside the run directory, so sessions could not write it']);
    const missing = join(tmpdir(), 'no-such-brief');
    const unreadable = { ...config, credential: () => ({ ok: false as const, problem: 'the credential /x does not exist' }) };
    expect(layoutProblems({ ...options, briefDir: missing }, unreadable, paths)).toEqual(['the credential /x does not exist', `the brief directory ${missing} does not exist`]);
  });

  test('refuses Playwright’s browsers when they are missing, contain the home directory or reach the agent’s credential', async () => {
    const { options, config } = await layout();
    const paths = sessionPaths(options.runDir, 'lead', 'stamp');
    const missing = join(tmpdir(), 'no-such-browsers');
    expect(layoutProblems(options, { ...config, browsers: missing }, paths)).toEqual([`Playwright's browsers are not at ${missing}, so the session could not start Chromium`]);
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    expect(layoutProblems(options, { ...config, browsers: home, home }, paths)).toEqual([`the bind ${home} contains the home directory ${home}`]);
    const secret = mkdtempSync(join(tmpdir(), 'factory-credential-'));
    const agent = fakeAgent({ credentialDirs: [secret] });
    expect(layoutProblems(options, { ...config, agent, browsers: secret }, paths)).toEqual([`the bind ${secret} reaches the agent's credential directory`]);
  });
});

describe('a session in its sandbox', () => {
  test('sees $BRIEF_DIR, $RUN_DIR and $APP_DIR, reads the brief, writes the run and the app, can’t write the brief, and logs to the host directory', async () => {
    const { options, config, upstream } = await layout();
    // Links a session could have planted in the run directory: the harness writes nothing through them.
    const decoy = join(mkdtempSync(join(tmpdir(), 'factory-decoy-')), 'host-file');
    writeFileSync(decoy, 'the host’s own file');
    for (const name of ['hosts', 'resolv.conf']) symlinkSync(decoy, join(options.runDir, name));
    const result = await runConfiguredSession('lead', options, config);
    expect(result).toMatchObject({ exitCode: 0, endedBy: 'exit' });
    expect(result.logPath.startsWith(`${hostDirOf(options.runDir)}/logs/`)).toBe(true);
    const lines = readFileSync(result.logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.find((line) => line.type === 'dirs')).toMatchObject({
      brief: options.briefDir, run: options.runDir, app: options.appDir,
      readBrief: 'ok', writeRun: 'ok', writeApp: 'ok', writeBrief: 'EROFS',
    });
    expect(lines.find((line) => line.type === 'instructions')?.text).toBe('the lead’s skill');
    expect(readFileSync(join(options.runDir, 'from-session.txt'), 'utf8')).toBe('written in the session');
    expect(existsSync(join(options.briefDir, 'from-session.txt'))).toBe(false);
    expect(upstream.received).toHaveLength(1);
    expect(readFileSync(decoy, 'utf8')).toBe('the host’s own file');
  }, SANDBOX_TEST_TIMEOUT_MS);

  test('starts a server on its own loopback and opens it in headless Chromium, with the browsers read-only and no more of the host’s HOME than its binds', async () => {
    const { options, config } = await layout();
    const plain = fakeAgent();
    const agent = fakeAgent({
      invocation: (session, bridgeUrl, env) => {
        const invocation = plain.invocation(session, bridgeUrl, env);
        return { ...invocation, env: { ...invocation.env, FAKE_AGENT_MODE: 'browser', PROBE_HOST_HOME: homedir() } };
      },
    });
    const result = await runConfiguredSession('user-agent', options, { ...config, agent });
    const stderr = readFileSync(`${result.logPath}.stderr`, 'utf8');
    expect(result, stderr).toMatchObject({ exitCode: 0, endedBy: 'exit' });
    const lines = readFileSync(result.logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const browser = lines.find((line) => line.type === 'browser');
    expect(browser).toMatchObject({
      title: 'served inside the session',
      heading: 'served inside the session',
      // Chromium says it is offline with only loopback; the shared script is what lets sign-in work.
      bareOnLine: false,
      onLine: true,
      signInEnabled: true,
      browsersPath: playwrightBrowsersPath(),
      writeBrowsers: 'EROFS',
      writeTmp: 'ok',
      writeShm: 'ok',
    });
    expect(browser?.error).toBeUndefined();
    const names = lines.find((line) => line.type === 'env')?.names;
    expect(names).toEqual(expect.arrayContaining(['PLAYWRIGHT_BROWSERS_PATH', PLAYWRIGHT_CLIENT_ENV, ONLINE_INIT_ENV, ...Object.keys(FAKE_MEDIA)]));
    // `next dev` can't take a second space-separated `--import` beside `pyric sandbox`'s.
    expect(names).not.toContain('NODE_OPTIONS');
    // The browsers' directory is bound alone: beside it, only the npm cache when that lives there too.
    const nameOf = (path: string) => basename(path);
    expect((browser?.besideBrowsers as string[]).filter((entry) => ![nameOf(playwrightBrowsersPath()), nameOf(npmCacheDir())].includes(entry))).toEqual([]);
    // Of the host's HOME, only what the sandbox binds on purpose: the browsers, the npm cache, the toolchain and the harness's repo.
    const topUnderHome = (path: string) => relative(homedir(), path).split('/')[0];
    const bound = new Set([playwrightBrowsersPath(), npmCacheDir(), ...toolchainDirs(), import.meta.dir].map(topUnderHome));
    expect((browser?.hostHomeEntries as string[]).filter((entry) => !bound.has(entry))).toEqual([]);
  }, SANDBOX_TEST_TIMEOUT_MS);
});
