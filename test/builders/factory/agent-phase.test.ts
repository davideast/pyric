// The agent phase on the host (`fixtures/phase-on-host.ts`), its stdout a
// pipe as `runAgentSession` gives it, with the made-up agent
// (`fixtures/fake-agent.ts`). Bun makes its own stdout pipe non-blocking
// once it is used, and a child that inherits the pipe inherits that too: an
// agent that prints one line larger than the pipe's buffer then gets EAGAIN
// and can crash. The phase gives the agent a pipe of its own. These tests
// send no request, so they run offline, under `unshare -rn`, with no bwrap.
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentPhase } from './agent-phase.ts';
import { FAKE_AGENT_CLI } from './fixtures/fake-agent.ts';

const ON_HOST = fileURLToPath(new URL('./fixtures/phase-on-host.ts', import.meta.url));
const ONE_MIB = 1024 * 1024;
/** A bridge port no other test uses; the phase only listens on it. */
const BRIDGE_PORT = 47_113;

interface PhaseRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function phaseFile(mode: string, command = FAKE_AGENT_CLI): string {
  const root = mkdtempSync(join(tmpdir(), 'factory-phase-'));
  const cwd = join(root, 'app');
  mkdirSync(cwd);
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, 'home'), FAKE_AGENT_MODE: mode };
  const phase: AgentPhase = {
    runRoot: root,
    socketPath: join(root, 'f.sock'),
    bridgePort: BRIDGE_PORT,
    homeDirs: [env.HOME],
    cwd,
    invocation: { command, args: ['--base-url', `http://127.0.0.1:${BRIDGE_PORT}`], env },
  };
  const file = join(root, 'phase.json');
  writeFileSync(file, JSON.stringify(phase));
  return file;
}

/** Runs the phase with piped stdio, reading its stdout only after a pause, as a busy harness drains it late. */
function runPhase(mode: string, command?: string): Promise<PhaseRun> {
  const child = spawn(process.execPath, [ON_HOST, phaseFile(mode, command)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.pause();
  setTimeout(() => child.stdout.resume(), 500);
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve) => {
    child.once('close', (code) => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

const linesOf = (text: string) => text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

describe('runAgentPhase', () => {
  test('the agent gets a blocking stdout of its own, and a 1 MiB line reaches the phase’s stdout whole', async () => {
    const run = await runPhase('big-line');
    const lines = linesOf(run.stdout);
    expect(lines.find((line) => line.type === 'stdout')).toEqual({ type: 'stdout', nonBlocking: false });
    expect(run.code).toBe(0);
    const big = lines.find((line) => line.type === 'big');
    expect(typeof big?.text === 'string' ? big.text.length : 0).toBe(ONE_MIB);
  });

  test('an agent that cannot start ends the phase with 127 and says why on stderr', async () => {
    const run = await runPhase('ok', join(tmpdir(), 'factory-phase-no-such-agent'));
    expect(run.code).toBe(127);
    expect(run.stderr).toContain('[agent-phase] the agent could not start');
  });
});
