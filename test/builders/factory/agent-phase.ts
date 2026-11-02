/**
 * An agent session's phase inside its sandbox. `runAgentSession` writes the
 * phase file into the session's sandbox directory, which the sandbox binds
 * read-only, and enters this file:
 *
 *   nsenter -t <pid> ... env -C <cwd> bun test/builders/factory/agent-phase.ts <phase file>
 *
 * It checks it is inside the run's sandbox, makes the session's HOME and the
 * directories the agent keeps there, starts the model channel's bridge on
 * the sandbox's loopback at the phase's port, then the agent's command,
 * which the harness built outside (`AgentAdapter.invocation`). The agent's
 * stdout is this process's stdout and nothing else is; the phase's own
 * lines go to stderr. A SIGTERM or SIGINT is passed on to the agent, and the
 * phase exits as the agent did.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname } from 'node:path';
import { z } from 'zod';
import { startBridge } from '../model-channel.ts';
import { assertInsideSandbox, inventoryLine } from '../sandbox-check.ts';

export const agentPhaseSchema = z.object({
  /** The run directory, whose sandbox the phase checks it is in before it starts anything. */
  runRoot: z.string().min(1),
  /** The Unix socket the bridge pipes to, where the forwarder outside listens. */
  socketPath: z.string().min(1),
  /** The bridge's port on the sandbox's loopback, which the invocation already names. */
  bridgePort: z.number().int().positive(),
  /** The session's HOME and the directories the agent keeps under it. */
  homeDirs: z.array(z.string().min(1)),
  cwd: z.string().min(1),
  invocation: z.object({ command: z.string().min(1), args: z.array(z.string()), env: z.record(z.string()) }).strict(),
}).strict();

export type AgentPhase = z.infer<typeof agentPhaseSchema>;

/** The exit code a shell gives a process a signal ended. */
export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 0);
}

/** Runs the session; resolves the agent's exit code. The entry point checks the sandbox first; the tests call this on the host. */
export async function runAgentPhase(phase: AgentPhase): Promise<number> {
  for (const dir of phase.homeDirs) mkdirSync(dir, { recursive: true });
  const bridge = await startBridge(phase.socketPath, phase.bridgePort);
  const { command, args, env } = phase.invocation;
  const child = spawn(command, args, { cwd: phase.cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
  const passOn = (signal: NodeJS.Signals) => child.kill(signal);
  process.on('SIGTERM', passOn);
  process.on('SIGINT', passOn);
  const code = await new Promise<number>((resolve) => {
    child.once('error', (error) => {
      console.error(`[agent-phase] the agent could not start: ${error.message}`);
      resolve(127);
    });
    child.once('close', (exit, signal) => resolve(exit ?? signalExitCode(signal ?? 'SIGKILL')));
  });
  await bridge.close();
  return code;
}

if (import.meta.main) {
  const file = process.argv[2];
  if (file === undefined) throw new Error('usage: bun test/builders/factory/agent-phase.ts <phase file>');
  const phase = agentPhaseSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  // The sandbox directory holds the forwarder's socket: the session's own, bound read-only.
  console.error(`[agent-phase] ${inventoryLine(assertInsideSandbox(phase.runRoot, 'start an agent session', [dirname(phase.socketPath)]))}`);
  process.exit(await runAgentPhase(phase));
}
