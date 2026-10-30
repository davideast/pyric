/**
 * A builder run's phase inside its sandbox. `round` writes `<run>/phase.json`
 * (the builder's command and its wall-clock cap) and enters this file:
 *
 *   nsenter -t <pid> ... env -C <repo> bun test/builders/run-phase.ts <run dir>
 *
 * It checks it is inside the sandbox before anything else, then starts the
 * model channel's bridge and the harness browser, runs the builder in the
 * app directory under the recorder with the run's scratch HOME, and writes
 * what happened to `<run>/phase-result.json`. The builder's output goes to
 * `logs/builder.log`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AppRun } from '../apps/driver.ts';
import { noDriverBrowser } from './app-install.ts';
import { BROWSER_WS_ENV, startBrowserServer, type BrowserServer } from './browser-server.ts';
import { proxyEnvironment, startBridge, type Listening } from './model-channel.ts';
import { builderRunDirsAt, type BuilderRunDirs } from './round-paths.ts';
import { assertInsideSandbox, inventoryLine } from './sandbox-check.ts';
import { recorderEnvironment } from './scratch.ts';

export const phaseSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string()),
  /** Names whose values the phase copies from its own environment, so a secret is never written to this file. */
  passEnv: z.array(z.string()),
  wallClockMs: z.number().int().positive(),
}).strict();

export type Phase = z.infer<typeof phaseSchema>;

export const phaseResultSchema = z.object({
  code: z.number().int().nullable(),
  timedOut: z.boolean(),
  wallMs: z.number().int().nonnegative(),
}).strict();

export type PhaseResult = z.infer<typeof phaseResultSchema>;

export const BUILDER_LOG = 'builder.log';

function step(line: string): void {
  console.log(`▸ ${line}`);
}

/** The values of `names` in this process's environment; a name that is unset is left out. */
export function passedThrough(names: readonly string[], env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(names.flatMap((name) => {
    const value = env[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

/** Runs the builder to exit or to its cap. AppRun's command throws only when it stops one at its limit. */
async function runBuilder(app: AppRun, phase: Phase, env: Record<string, string>): Promise<{ result: PhaseResult; output: string }> {
  const started = Date.now();
  try {
    const run = await app.command(phase.command, phase.args, { env, timeoutMs: phase.wallClockMs });
    return { result: { code: run.code, timedOut: false, wallMs: Date.now() - started }, output: run.output };
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);
    return { result: { code: null, timedOut: true, wallMs: Date.now() - started }, output };
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
    const env = { ...recorderEnvironment(dirs.networkLog), ...proxyEnvironment(started.port), ...phase.env, ...passedThrough(phase.passEnv), [BROWSER_WS_ENV]: browser.wsEndpoint };
    step(`builder: ${phase.command}, for at most ${phase.wallClockMs / 60_000} minutes`);
    const { result, output } = await runBuilder(app, phase, env);
    writeFileSync(join(dirs.logs, BUILDER_LOG), output);
    writeFileSync(dirs.phaseResult, `${JSON.stringify(result)}\n`);
  } finally {
    await browser?.stop();
    await app.close();
    await bridge?.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (root === undefined) throw new Error('usage: bun test/builders/run-phase.ts <run dir>');
  step(inventoryLine(assertInsideSandbox(root, 'start a builder')));
  await runPhase(builderRunDirsAt(root));
}
