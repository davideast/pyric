// runAgentSession end to end on loopback with the made-up agent
// (`fixtures/fake-agent.ts`): the real forwarder, phase and bridge, and a
// stand-in upstream on loopback. The sandbox is left out (`enter` runs the
// command on the host, and the phase skips its check), so these tests run
// offline, under `unshare -rn`, with no bwrap.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSession } from './agent.ts';
import { phaseFileOf, runAgentSession, stopReason, type AgentSessionOptions } from './agent-session.ts';
import { FAKE_AGENT_CLI, FAKE_TOKEN, fakeAgent } from './fixtures/fake-agent.ts';
import { startFakeUpstream, type FakeUpstream } from './fixtures/fake-upstream.ts';
import { HostFileError } from './host-files.ts';

const ON_HOST = fileURLToPath(new URL('./fixtures/phase-on-host.ts', import.meta.url));
const upstreams: FakeUpstream[] = [];

afterEach(async () => {
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
});

/** A port free on loopback, for the bridge of a phase run on the host. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
}

interface Run {
  runRoot: string;
  host: string;
  upstream: FakeUpstream;
  sessions: number;
}

async function newRun(): Promise<Run> {
  const upstream = await startFakeUpstream();
  upstreams.push(upstream);
  return { runRoot: mkdtempSync(join(tmpdir(), 'factory-session-')), host: mkdtempSync(join(tmpdir(), 'factory-session-host-')), upstream, sessions: 0 };
}

/** One session's options in `run`: its own sandbox directory and log, and the run's shared channel record. */
async function sessionIn(run: Run, mode: string, overrides: Partial<AgentSessionOptions> = {}): Promise<AgentSessionOptions> {
  run.sessions += 1;
  const briefDir = mkdtempSync(join(tmpdir(), 'factory-brief-'));
  writeFileSync(join(briefDir, 'BRIEF.md'), 'the brief');
  const session: AgentSession = {
    command: FAKE_AGENT_CLI, cwd: join(run.runRoot, 'app'), runDir: run.runRoot, briefDir, home: join(run.runRoot, 'homes', 'builder-1'),
    prompt: 'build', instructions: 'the role’s skill',
  };
  mkdirSync(session.cwd, { recursive: true });
  const sandboxDir = join(run.host, `s-${run.sessions}`);
  mkdirSync(sandboxDir);
  return {
    agent: fakeAgent(),
    session,
    runRoot: run.runRoot,
    sandboxDir,
    logPath: join(run.host, `session-${run.sessions}.jsonl`),
    channelRecord: join(run.host, 'channel.jsonl'),
    deadlineMs: 30_000,
    enter: (command, args) => ({ command, args: [...args] }),
    base: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_AGENT_MODE: mode },
    upstream: { host: '127.0.0.1', port: run.upstream.port, tls: false },
    phaseScript: ON_HOST,
    bridgePort: await freePort(),
    ...overrides,
  };
}

const linesOf = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

/** Whether `pid` is gone: no process, or a zombie no one has reaped yet. */
function isGone(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z') === true;
  } catch {
    return true;
  }
}

async function waitUntilGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (isGone(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return isGone(pid);
}

describe('runAgentSession', () => {
  test('runs a session through the bridge and the forwarder, which alone adds the credential, and ends by its exit', async () => {
    const run = await newRun();
    const options = await sessionIn(run, 'ok');
    const result = await runAgentSession(options);
    expect(result).toEqual({ exitCode: 0, endedBy: 'exit', logPath: options.logPath });
    expect(linesOf(options.logPath).map((line) => line.type)).toEqual(['env', 'instructions', 'dirs', 'done']);
    expect(run.upstream.received[0]?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(run.upstream.received[0]?.headers.host).toBe('upstream.invalid');
    const written = readFileSync(options.logPath, 'utf8') + readFileSync(phaseFileOf(options.sandboxDir), 'utf8');
    expect(written).not.toContain(FAKE_TOKEN);
  });

  test('the agent gets HOME, the three directories, the adapter’s own variables and the base, and the skill as its instructions', async () => {
    const run = await newRun();
    const options = await sessionIn(run, 'ok');
    await runAgentSession(options);
    const lines = linesOf(options.logPath);
    expect(lines.find((line) => line.type === 'env')?.names).toEqual(['APP_DIR', 'BRIEF_DIR', 'FAKE_AGENT_HOME', 'FAKE_AGENT_MODE', 'HOME', 'PATH', 'RUN_DIR']);
    expect(lines.find((line) => line.type === 'instructions')?.text).toBe('the role’s skill');
    expect(existsSync(join(options.session.home, '.fake-agent'))).toBe(true);
  });

  test('at the upstream rate limit, it ends by the rate limit with the reset the upstream named', async () => {
    const run = await newRun();
    run.upstream.limitedUntil = 1793790664;
    const result = await runAgentSession(await sessionIn(run, 'limit'));
    expect(result).toMatchObject({ exitCode: 1, endedBy: 'rate-limit', resetAt: '2026-11-04T11:11:04.000Z' });
  });

  test('an earlier session’s 429 in the shared record does not make a later failure rate-limited', async () => {
    const run = await newRun();
    run.upstream.limitedUntil = 1793790664;
    expect((await runAgentSession(await sessionIn(run, 'limit'))).endedBy).toBe('rate-limit');
    // No request of its own: only the earlier session's 429 is in the record, so only the slice keeps this an exit.
    const result = await runAgentSession(await sessionIn(run, 'crash'));
    expect(result).toMatchObject({ exitCode: 1, endedBy: 'exit' });
  });

  test('a session that runs past its deadline is stopped and ends by the deadline', async () => {
    const run = await newRun();
    const result = await runAgentSession(await sessionIn(run, 'hang', { deadlineMs: 1_500 }));
    expect(result.endedBy).toBe('deadline');
    expect(result.exitCode).not.toBe(0);
  });

  test('an abort stops the session and resolves: killed when stopped, deadline at the run’s end', async () => {
    const run = await newRun();
    const stopped = new AbortController();
    setTimeout(() => stopped.abort('stopped'), 1_000);
    expect((await runAgentSession(await sessionIn(run, 'hang', { signal: stopped.signal }))).endedBy).toBe('killed');
    const atEnd = new AbortController();
    setTimeout(() => atEnd.abort('deadline'), 1_000);
    expect((await runAgentSession(await sessionIn(run, 'hang', { signal: atEnd.signal }))).endedBy).toBe('deadline');
  });

  test('a stop signals the phase’s whole process group, so a process the agent started that no one passes signals to ends too', async () => {
    const run = await newRun();
    const options = await sessionIn(run, 'grandchild', { deadlineMs: 1_500, stopGraceMs: 1_000 });
    const result = await runAgentSession(options);
    expect(result.endedBy).toBe('deadline');
    const pid = linesOf(options.logPath).find((line) => line.type === 'grandchild')?.pid;
    expect(typeof pid).toBe('number');
    expect(await waitUntilGone(pid as number, 3_000)).toBe(true);
  });

  test('a fault in the forwarder stops the session as killed and says so on its stderr', async () => {
    const run = await newRun();
    const credential = () => {
      throw new Error('the credential reader failed');
    };
    const options = await sessionIn(run, 'ok', { credential });
    const result = await runAgentSession(options);
    expect(result.endedBy).toBe('killed');
    expect(readFileSync(`${options.logPath}.stderr`, 'utf8')).toContain('[agent-session] the upstream forwarder dropped a request that failed (Error); stopping the session');
    expect(run.upstream.received).toEqual([]);
  });

  test('stopReason maps the supervisor’s abort reasons', () => {
    expect(stopReason('deadline')).toBe('deadline');
    expect(stopReason('stopped')).toBe('killed');
    expect(stopReason(undefined)).toBe('killed');
  });
});

describe('host writes never follow a planted link', () => {
  for (const planted of ['the phase file', 'the log', 'the log’s stderr']) {
    test(`refuses to start when ${planted} is already a link, and the link’s target is unchanged`, async () => {
      const run = await newRun();
      const options = await sessionIn(run, 'ok');
      const target = join(mkdtempSync(join(tmpdir(), 'factory-decoy-')), 'host-file');
      writeFileSync(target, 'the host’s own file');
      const paths: Record<string, string> = { 'the phase file': phaseFileOf(options.sandboxDir), 'the log': options.logPath, 'the log’s stderr': `${options.logPath}.stderr` };
      symlinkSync(target, paths[planted] ?? '');
      await expect(runAgentSession(options)).rejects.toBeInstanceOf(HostFileError);
      expect(readFileSync(target, 'utf8')).toBe('the host’s own file');
    });
  }
});
