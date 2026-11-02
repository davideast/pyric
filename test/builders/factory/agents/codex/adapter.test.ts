// The Codex adapter end to end on this machine, through the generic
// session: the real forwarder, phase and bridge, a scripted Codex
// (`fixtures/fake-codex.ts`), a made-up login and a stand-in backend on
// loopback. The sandbox is left out (`enter` runs the command on the host,
// and the phase skips its check), so these tests run offline, under
// `unshare -rn`, with no bwrap.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSession } from '../../agent.ts';
import { phaseFileOf, runAgentSession, type AgentSessionOptions } from '../../agent-session.ts';
import { codexAgent } from './adapter.ts';
import { parseEvents } from './events.ts';
import { startFakeChatgpt, type FakeChatgpt } from './fixtures/fake-chatgpt.ts';
import { fakeLogin } from './fixtures/fake-login.ts';
import { codexCredential } from './login.ts';

const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex.ts', import.meta.url));
const ON_HOST = fileURLToPath(new URL('../../fixtures/phase-on-host.ts', import.meta.url));
const backends: FakeChatgpt[] = [];

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
});

/** A port free on this machine, for the bridge of a phase run on the host. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
}

async function setup(mode: string) {
  const runRoot = mkdtempSync(join(tmpdir(), 'factory-codex-'));
  const host = mkdtempSync(join(tmpdir(), 'factory-codex-host-'));
  const backend = await startFakeChatgpt();
  backends.push(backend);
  const briefDir = mkdtempSync(join(tmpdir(), 'factory-brief-'));
  writeFileSync(join(briefDir, 'BRIEF.md'), 'the brief');
  const session: AgentSession = {
    command: FAKE_CODEX, cwd: join(runRoot, 'app'), runDir: runRoot, briefDir, home: join(runRoot, 'homes', 'builder-1'),
    prompt: 'build', instructions: 'the role’s skill',
  };
  mkdirSync(session.cwd, { recursive: true });
  const sandboxDir = join(host, 's');
  mkdirSync(sandboxDir);
  const login = fakeLogin();
  const options: AgentSessionOptions = {
    agent: codexAgent,
    session,
    runRoot,
    sandboxDir,
    logPath: join(host, 'events.jsonl'),
    channelRecord: join(host, 'channel.jsonl'),
    deadlineMs: 30_000,
    enter: (command, args) => ({ command, args: [...args] }),
    base: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_CODEX_MODE: mode },
    credential: () => ({ ok: true, credential: codexCredential(login) }),
    upstream: { host: '127.0.0.1', port: backend.port, tls: false },
    phaseScript: ON_HOST,
    bridgePort: await freePort(),
  };
  return { options, backend, login };
}

const eventsOf = (path: string) => parseEvents(readFileSync(path, 'utf8'));

describe('the Codex adapter in a session', () => {
  test('runs through the bridge and the forwarder, which puts the login on, and no token reaches the log or the phase file', async () => {
    const { options, backend, login } = await setup('ok');
    const result = await runAgentSession(options);
    expect(result).toEqual({ exitCode: 0, endedBy: 'exit', logPath: options.logPath });
    expect(eventsOf(options.logPath).map((event) => event.type)).toEqual(['thread.started', 'fake.env', 'fake.instructions', 'fake.dirs', 'turn.started', 'turn.completed']);
    expect(backend.received[0]?.headers.authorization).toBe(`Bearer ${login.accessToken}`);
    const written = readFileSync(options.logPath, 'utf8') + readFileSync(phaseFileOf(options.sandboxDir), 'utf8');
    for (const secret of login.secrets) expect(written).not.toContain(secret);
  });

  test('Codex gets HOME, CODEX_HOME, the three directories and the base, and the skill as its developer instructions', async () => {
    const { options } = await setup('ok');
    await runAgentSession(options);
    const events = eventsOf(options.logPath);
    expect(events.find((event) => event.type === 'fake.env')?.names).toEqual(['APP_DIR', 'BRIEF_DIR', 'CODEX_HOME', 'FAKE_CODEX_MODE', 'HOME', 'PATH', 'RUN_DIR']);
    expect(events.find((event) => event.type === 'fake.instructions')?.text).toBe('the role’s skill');
    expect(events.find((event) => event.type === 'fake.dirs')).toMatchObject({ brief: options.session.briefDir, run: options.runRoot, app: options.session.cwd, readBrief: 'ok', writeRun: 'ok' });
  });

  test('out of usage, it ends by the rate limit with the reset the backend named', async () => {
    const { options, backend } = await setup('limit');
    backend.limitedUntil = 1793790664;
    const result = await runAgentSession(options);
    expect(result).toEqual({ exitCode: 1, endedBy: 'rate-limit', resetAt: '2026-11-04T11:11:04.000Z', logPath: options.logPath });
  });
});
