// runCodexSession end to end on this machine: the real forwarder, phase and
// bridge, a scripted Codex (`fixtures/fake-codex.ts`), a made-up login and
// a stand-in backend on loopback. The sandbox is left out (`enter` runs the
// command on the host, and the phase skips its check), so these tests run
// offline, under `unshare -rn`, with no bwrap.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodexSession } from './codex-command.ts';
import { parseEvents } from './codex-events.ts';
import { runCodexSession, stopReason, type CodexSessionOptions } from './codex-session.ts';
import { startFakeChatgpt, type FakeChatgpt } from './fake-chatgpt.ts';
import { fakeLogin } from './fake-login.ts';

const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex.ts', import.meta.url));
const ON_HOST = fileURLToPath(new URL('./fixtures/codex-phase-on-host.ts', import.meta.url));
const backends: FakeChatgpt[] = [];

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
});

async function setup(mode: string, overrides: Partial<CodexSessionOptions> = {}) {
  const runRoot = mkdtempSync(join(tmpdir(), 'factory-session-'));
  const backend = await startFakeChatgpt();
  backends.push(backend);
  const briefDir = mkdtempSync(join(tmpdir(), 'factory-brief-'));
  writeFileSync(join(briefDir, 'BRIEF.md'), 'the brief');
  const skillFile = join(briefDir, 'SKILL.md');
  writeFileSync(skillFile, 'the role’s skill');
  const session: CodexSession = {
    codex: FAKE_CODEX, cwd: join(runRoot, 'app'), runDir: runRoot, briefDir, home: join(runRoot, 'homes', 'builder-1'),
    model: 'gpt-6.1-sol', reasoningEffort: 'max', prompt: 'build', skillFile,
  };
  mkdirSync(session.cwd, { recursive: true });
  mkdirSync(join(session.home, '.codex'), { recursive: true });
  const login = fakeLogin();
  const options: CodexSessionOptions = {
    session,
    runRoot,
    phaseFile: join(runRoot, 'phase.json'),
    socketPath: join(runRoot, 's.sock'),
    channelRecord: join(`${runRoot}.channel.jsonl`),
    logPath: join(runRoot, 'events.jsonl'),
    deadlineMs: 30_000,
    enter: (command, args) => ({ command, args: [...args] }),
    base: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_CODEX_MODE: mode },
    login: () => ({ ok: true, login }),
    upstream: { host: '127.0.0.1', port: backend.port, tls: false },
    phaseScript: ON_HOST,
    ...overrides,
  };
  return { options, backend, login };
}

const eventsOf = (path: string) => parseEvents(readFileSync(path, 'utf8'));

describe('runCodexSession', () => {
  test('runs a session through the bridge and the forwarder, saving its events, and ends by its exit', async () => {
    const { options, backend, login } = await setup('ok');
    const result = await runCodexSession(options);
    expect(result).toEqual({ exitCode: 0, endedBy: 'exit', logPath: options.logPath });
    expect(eventsOf(options.logPath).map((event) => event.type)).toEqual(['thread.started', 'fake.env', 'fake.instructions', 'fake.dirs', 'turn.started', 'turn.completed']);
    expect(backend.received[0]?.headers.authorization).toBe(`Bearer ${login.accessToken}`);
    const log = readFileSync(options.logPath, 'utf8');
    for (const secret of login.secrets) expect(log).not.toContain(secret);
    expect(readFileSync(options.phaseFile, 'utf8')).not.toContain(login.accessToken);
  });

  test('Codex gets HOME, CODEX_HOME, the three directories and the base, and the skill as its instructions', async () => {
    const { options } = await setup('ok');
    await runCodexSession(options);
    const events = eventsOf(options.logPath);
    const names = events.find((event) => event.type === 'fake.env')?.names;
    expect(names).toEqual(['APP_DIR', 'BRIEF_DIR', 'CODEX_HOME', 'FAKE_CODEX_MODE', 'HOME', 'PATH', 'RUN_DIR']);
    expect(events.find((event) => event.type === 'fake.instructions')?.text).toBe('the role’s skill');
    expect(events.find((event) => event.type === 'fake.dirs')).toMatchObject({ brief: options.session.briefDir, run: options.runRoot, app: options.session.cwd, readBrief: 'ok', writeRun: 'ok' });
  });

  test('out of usage, it ends by the rate limit with the reset the backend named', async () => {
    const { options, backend } = await setup('limit');
    backend.limitedUntil = 1793790664;
    const result = await runCodexSession(options);
    expect(result).toEqual({ exitCode: 1, endedBy: 'rate-limit', resetAt: '2026-11-04T11:11:04.000Z', logPath: options.logPath });
  });

  test('an earlier session’s 429 in the shared record does not make this one rate-limited', async () => {
    const { options, backend } = await setup('limit');
    backend.limitedUntil = 1793790664;
    await runCodexSession(options);
    backend.limitedUntil = null;
    const result = await runCodexSession({ ...options, base: { ...options.base, FAKE_CODEX_MODE: 'ok' } });
    expect(result.endedBy).toBe('exit');
  });

  test('a session that runs past its deadline is stopped and ends by the deadline', async () => {
    const { options } = await setup('hang', { deadlineMs: 1_500 });
    const result = await runCodexSession(options);
    expect(result.endedBy).toBe('deadline');
    expect(result.exitCode).not.toBe(0);
  });

  test('an abort stops the session and resolves: killed when stopped, deadline at the run’s end', async () => {
    const stopped = new AbortController();
    const first = await setup('hang', { signal: stopped.signal });
    setTimeout(() => stopped.abort('stopped'), 1_000);
    expect((await runCodexSession(first.options)).endedBy).toBe('killed');
    const atEnd = new AbortController();
    const second = await setup('hang', { signal: atEnd.signal });
    setTimeout(() => atEnd.abort('deadline'), 1_000);
    expect((await runCodexSession(second.options)).endedBy).toBe('deadline');
  });

  test('stopReason maps the supervisor’s abort reasons', () => {
    expect(stopReason('deadline')).toBe('deadline');
    expect(stopReason('stopped')).toBe('killed');
    expect(stopReason(undefined)).toBe('killed');
  });
});
