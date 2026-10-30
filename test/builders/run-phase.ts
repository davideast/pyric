/**
 * A builder run's phase inside its sandbox. `round` writes `<run>/phase.json`
 * (the builder's command and its wall-clock cap) and enters this file:
 *
 *   nsenter -t <pid> ... env -C <repo> bun test/builders/run-phase.ts <run dir>
 *
 * It checks it is inside the sandbox before anything else, then starts the
 * model channel's bridge and the harness browser, runs the builder in the
 * app directory under the recorder with the run's scratch HOME and
 * `ANTHROPIC_BASE_URL` pointed at the bridge, and writes
 * what happened to `<run>/phase-result.json`. The builder's output goes to
 * `logs/builder.log`.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AppRun } from '../apps/driver.ts';
import { noDriverBrowser } from './app-install.ts';
import { BROWSER_WS_ENV, startBrowserServer, type BrowserServer } from './browser-server.ts';
import { channelEnvironment, startBridge, type Listening } from './model-channel.ts';
import { builderRunDirsAt, type BuilderRunDirs } from './round-paths.ts';
import { assertInsideSandbox, inventoryLine } from './sandbox-check.ts';
import { recorderEnvironment } from './scratch.ts';

export const phaseSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string()),
  wallClockMs: z.number().int().positive(),
}).strict();

export type Phase = z.infer<typeof phaseSchema>;

export const phaseResultSchema = z.object({
  /** The builder's exit code; null when it was stopped or never started. */
  code: z.number().int().nullable(),
  /** Stopped at its wall-clock cap. */
  timedOut: z.boolean(),
  /** Why the builder could not be run at all, when it could not. */
  error: z.string().nullable(),
  wallMs: z.number().int().nonnegative(),
}).strict();

export type PhaseResult = z.infer<typeof phaseResultSchema>;

export const BUILDER_LOG = 'builder.log';

/** Where the phase writes each step as it happens, so a phase that hangs can still be read. */
export const PHASE_STEPS_LOG = 'run-phase-steps.log';
let stepsLog: string | undefined;

function step(line: string): void {
  console.log(`▸ ${line}`);
  if (stepsLog !== undefined) appendFileSync(stepsLog, `${new Date().toISOString()} ${line}\n`);
}

/** How AppRun's command says it stopped a command at its limit; any other throw is a failure to run it. */
const STOPPED_AT_LIMIT = / did not exit within \d+(\.\d+)?s:/;

export function isStoppedAtLimit(message: string): boolean {
  return STOPPED_AT_LIMIT.test(message.split('\n')[0] ?? '');
}

/** Runs the builder to exit or to its cap. */
async function runBuilder(app: AppRun, phase: Phase, env: Record<string, string>): Promise<{ result: PhaseResult; output: string }> {
  const started = Date.now();
  try {
    const run = await app.command(phase.command, phase.args, { env, timeoutMs: phase.wallClockMs });
    return { result: { code: run.code, timedOut: false, error: null, wallMs: Date.now() - started }, output: run.output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = isStoppedAtLimit(message);
    const failure = timedOut ? null : message.split('\n')[0] ?? message;
    return { result: { code: null, timedOut, error: failure, wallMs: Date.now() - started }, output: message };
  }
}

async function runPhase(dirs: BuilderRunDirs): Promise<void> {
  const phase = phaseSchema.parse(JSON.parse(readFileSync(dirs.phase, 'utf8')));
  const app = new AppRun('builder', dirs.app, dirs.home, noDriverBrowser);
  let bridge: Listening | undefined;
  let browser: BrowserServer | undefined;
  try {
    step('starting the model channel bridge and the harness browser');
    const started = await startBridge(dirs.modelSocket);
    bridge = started;
    browser = await startBrowserServer({ netLogPath: dirs.netLog, networkLog: dirs.networkLog, home: dirs.home });
    const env = { ...recorderEnvironment(dirs.networkLog), ...phase.env, ...channelEnvironment(started.port), [BROWSER_WS_ENV]: browser.wsEndpoint };
    step(`builder: ${phase.command}, for at most ${phase.wallClockMs / 60_000} minutes`);
    const { result, output } = await runBuilder(app, phase, env);
    writeFileSync(join(dirs.logs, BUILDER_LOG), output);
    writeFileSync(dirs.phaseResult, `${JSON.stringify(result)}\n`);
  } finally {
    step('stopping the harness browser');
    await browser?.stop();
    step('stopping the app processes');
    await app.close();
    step('closing the bridge');
    await bridge?.close();
    step('stopped');
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (root === undefined) throw new Error('usage: bun test/builders/run-phase.ts <run dir>');
  const dirs = builderRunDirsAt(root);
  stepsLog = join(dirs.logs, PHASE_STEPS_LOG);
  step(inventoryLine(assertInsideSandbox(root, 'start a builder')));
  await runPhase(dirs);
  // AppRun's command races the builder against a sleep of its whole
  // wall-clock cap and never clears that timer, which would hold this
  // process open for the rest of the cap. Everything is stopped by now.
  process.exit(0);
}
