/**
 * A Codex session's phase inside its sandbox. `runCodexSession` writes the
 * phase file and enters this file:
 *
 *   nsenter -t <pid> ... env -C <cwd> bun test/builders/factory/codex-phase.ts <phase file>
 *
 * It checks it is inside the run's sandbox, then starts the model channel's bridge on the sandbox's loopback, then
 * `codex exec` (`codex-command.ts`) pointed at it. Codex's stdout, its JSON
 * events, is this process's stdout and nothing else is; the phase's own
 * lines go to stderr. A SIGTERM or SIGINT is passed on to Codex, and the
 * phase exits as Codex did.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { openSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { startBridge } from '../model-channel.ts';
import { assertInsideSandbox, inventoryLine } from '../sandbox-check.ts';
import { codexInvocation, REASONING_EFFORTS } from './codex-command.ts';

export const codexPhaseSchema = z.object({
  session: z.object({
    codex: z.string().min(1),
    cwd: z.string().min(1),
    home: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.enum(REASONING_EFFORTS),
    prompt: z.string().min(1),
    skillFile: z.string().min(1).optional(),
  }).strict(),
  /** The run directory, whose sandbox the phase checks it is in before it starts anything. */
  runRoot: z.string().min(1),
  /** The Unix socket the bridge pipes to, where the forwarder outside listens. */
  socketPath: z.string().min(1),
  /** Codex's environment besides HOME and CODEX_HOME: PATH, LANG, TMPDIR, the recorder's variables. No secret. */
  base: z.record(z.string()),
}).strict();

export type CodexPhase = z.infer<typeof codexPhaseSchema>;

/** The exit code a shell gives a process a signal ended. */
export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 0);
}

/** Runs the session; resolves Codex's exit code. The entry point checks the sandbox first; the tests call this on the host. */
export async function runCodexPhase(phase: CodexPhase): Promise<number> {
  const bridge = await startBridge(phase.socketPath);
  const invocation = codexInvocation(phase.session, bridge.port, phase.base);
  const stdin = invocation.stdinFile === null ? 'ignore' : openSync(invocation.stdinFile, 'r');
  const child = spawn(invocation.command, invocation.args, { cwd: phase.session.cwd, env: invocation.env, stdio: [stdin, 'inherit', 'inherit'] });
  const passOn = (signal: NodeJS.Signals) => child.kill(signal);
  process.on('SIGTERM', passOn);
  process.on('SIGINT', passOn);
  const code = await new Promise<number>((resolve) => {
    child.once('error', (error) => {
      console.error(`[codex-phase] codex could not start: ${error.message}`);
      resolve(127);
    });
    child.once('close', (exit, signal) => resolve(exit ?? signalExitCode(signal ?? 'SIGKILL')));
  });
  await bridge.close();
  return code;
}

if (import.meta.main) {
  const file = process.argv[2];
  if (file === undefined) throw new Error('usage: bun test/builders/factory/codex-phase.ts <phase file>');
  const phase = codexPhaseSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  console.error(`[codex-phase] ${inventoryLine(assertInsideSandbox(phase.runRoot, 'start a Codex session'))}`);
  process.exit(await runCodexPhase(phase));
}
