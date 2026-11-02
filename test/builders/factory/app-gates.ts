/**
 * The gates that run in a tree's sandbox, and the walks from the walk
 * sandbox:
 *
 * - Studio's typecheck (as its CI runs it), its tests (`bun test test/studio`
 *   at the repo root) and its own ast-grep rule tests and scan, with the
 *   harness's ast-grep and ffmpeg. Their verdicts come from each command's
 *   exit and output alone.
 * - The one command start, the allowlist entry the walks sign in with, and
 *   the walks, run in a walk sandbox of their own against Studio through the
 *   relay (`relay.ts`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EgressNamespace } from '../namespace.ts';
import type { AppPaths, Checkout } from './app-paths.ts';
import { APP_PORT, PYRIC_PORT, startApp, studioEnvironment, type StartedApp } from './app-start.ts';
import { runWalkJob, WALK_EMAIL } from './captures.ts';
import { Aborted, type Run, type Runner } from './exec.ts';
import { skipped, type GateName, type GateResult } from './gates.ts';
import { optional } from './optional.ts';
import { insideSandbox, relaySocketToSocket, shortLink, startInsideBridge, waitForSocket } from './relay.ts';
import { specAt, type SandboxOpener } from './sandbox.ts';
import { newWorkRoot } from './tree.ts';
import type { WalkResult } from './walk-runner.ts';

const TYPECHECK_TIMEOUT_MS = 10 * 60_000;
const TESTS_TIMEOUT_MS = 15 * 60_000;
const AST_GREP_TIMEOUT_MS = 3 * 60_000;
const ALLOWLIST_TIMEOUT_MS = 2 * 60_000;
/** Studio's ports, each carried from the walk sandbox's loopback to Studio's. */
const BRIDGED = [{ port: APP_PORT, socket: 'app.sock' }, { port: PYRIC_PORT, socket: 'pyric.sock' }];

function failedSummary(step: Run, result: { code: number | null; timedOut: boolean }): string {
  const what = step.args.slice(0, 2).join(' ') || step.command;
  if (result.timedOut) return `${what} timed out`;
  return `${what} exited ${result.code}`;
}

/** Runs `steps` in order and stops at the first failure; the gate's output is every step's. */
export async function gate(runner: Runner, name: GateName, steps: readonly Run[]): Promise<GateResult> {
  let output = '';
  for (const step of steps) {
    const result = await runner(step);
    output += `$ ${step.command} ${step.args.join(' ')}\n${result.output}\n`;
    const exit = { code: result.code, timedOut: result.timedOut };
    const failed = result.code !== 0 || result.timedOut;
    if (failed) return { gate: name, passed: false, summary: failedSummary(step, result), output, exit };
  }
  return { gate: name, passed: true, summary: 'passed', output, exit: { code: 0, timedOut: false } };
}

export interface StaticTools {
  astGrep: string;
  ffmpeg?: string;
}

export async function staticGates(runner: Runner, checkout: Checkout, tools: StaticTools): Promise<GateResult[]> {
  const studio = checkout.studio;
  const typecheck = await gate(runner, 'typecheck', [
    { command: 'node', args: ['node_modules/next/dist/bin/next', 'typegen'], cwd: studio, timeoutMs: TYPECHECK_TIMEOUT_MS },
    { command: 'node', args: ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false'], cwd: studio, timeoutMs: TYPECHECK_TIMEOUT_MS },
  ]);
  const ffmpeg: Record<string, string> = { ...optional('FFMPEG_BIN', tools.ffmpeg) };
  const tests = await gate(runner, 'tests', [{ command: 'bun', args: ['test', 'test/studio'], cwd: checkout.repo, timeoutMs: TESTS_TIMEOUT_MS, env: ffmpeg }]);
  const checks = await gate(runner, 'studio-checks', [
    { command: tools.astGrep, args: ['test', '-c', 'checks/sgconfig.yml'], cwd: studio, timeoutMs: AST_GREP_TIMEOUT_MS },
    { command: tools.astGrep, args: ['scan', '-c', 'checks/sgconfig.yml'], cwd: studio, timeoutMs: AST_GREP_TIMEOUT_MS },
  ]);
  return [typecheck, tests, checks];
}

/** One capture from a started Studio: walks, fixed routes, or both. */
export interface WalkJobSpec {
  label: string;
  walks: readonly string[];
  routes: readonly string[];
  outDir: string;
}

export interface WalkRun {
  appStart: GateResult;
  walks: GateResult;
  /** The first job's result. */
  result?: WalkResult;
  /** Every job's result that ran, by label. */
  results: Map<string, WalkResult>;
}

export interface WalkRunInput {
  paths: AppPaths;
  runner: Runner;
  namespace: EgressNamespace;
  checkout: Checkout;
  openSandbox: SandboxOpener;
  briefDir: string;
  logDir: string;
  /** The first job's walks are the gate; the rest only capture. */
  jobs: readonly WalkJobSpec[];
  signal?: AbortSignal;
}

/** Adds the walks' account to Studio's allowlist in the running sandbox: Studio signs out anyone not on it. */
async function allowWalker(runner: Runner, checkout: Checkout): Promise<string> {
  const env = { ...studioEnvironment({ checkout }), PYRIC_SANDBOX: `remote:http://127.0.0.1:${PYRIC_PORT}` };
  const result = await runner({ command: 'node', args: ['scripts/allowlist.mjs', 'add', WALK_EMAIL, '--local'], cwd: checkout.studio, timeoutMs: ALLOWLIST_TIMEOUT_MS, env });
  return `allowlist add ${WALK_EMAIL} --local: exit ${result.code}\n${result.output}`;
}

export function walkGate(result: WalkResult, expected: number): GateResult {
  const failing = result.walks.filter((walk) => !walk.passed);
  const output = failing.map((walk) => `${walk.name}:\n${walk.error ?? ''}`).join('\n\n');
  if (expected === 0) return { gate: 'walks', passed: false, summary: 'the brief has no walk scripts' };
  if (failing.length > 0) return { gate: 'walks', passed: false, summary: `${failing.length} of ${expected} walks failed: ${failing.map((walk) => walk.name).join(', ')}`, output };
  return { gate: 'walks', passed: true, summary: `${expected} walks passed` };
}

/** Starts the inside bridges in Studio's sandbox: a Unix socket per port, in `<root>/sockets`. */
async function bridgeStudio(input: WalkRunInput): Promise<string> {
  const sockets = join(input.checkout.root, 'sockets');
  for (const { port, socket } of BRIDGED) startInsideBridge(input.namespace, ['unix-to-tcp', socket, String(port)], sockets, input.signal);
  const reach = insideSandbox(input.namespace.pid, sockets);
  for (const { socket } of BRIDGED) await waitForSocket(join(reach, socket));
  return reach;
}

/** Opens the walk sandbox, relays its loopback ports to Studio's, and runs every job there. */
async function walkFromSandbox(input: WalkRunInput, studioSockets: string, baseURL: string): Promise<Map<string, WalkResult>> {
  const root = newWorkRoot(input.paths, 'walk');
  const sockets = join(root, 'sockets');
  mkdirSync(sockets);
  const reach = shortLink(root);
  const relays = await Promise.all(BRIDGED.map(({ socket }) => relaySocketToSocket(join(reach, 'sockets', socket), join(studioSockets, socket))));
  try {
    return await input.openSandbox(specAt(root, input.signal, [input.briefDir]), input.paths, async (runner, namespace) => {
      for (const { port, socket } of BRIDGED) startInsideBridge(namespace, ['tcp-to-unix', String(port), socket], sockets, input.signal);
      const results = new Map<string, WalkResult>();
      for (const job of input.jobs) {
        const result = await runWalkJob({ runner, root, label: job.label, baseURL, briefDir: input.briefDir, walks: job.walks, routes: job.routes, outDir: job.outDir });
        results.set(job.label, result);
      }
      return results;
    });
  } finally {
    for (const relay of relays) relay.close();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Starts Studio, walks it from the walk sandbox and captures its pages, then stops it. */
export async function startAndWalk(input: WalkRunInput): Promise<WalkRun> {
  const first = input.jobs[0];
  const expected = first?.walks.length ?? 0;
  let app: StartedApp;
  try {
    app = await startApp({ checkout: input.checkout, namespace: input.namespace, logFile: join(input.logDir, 'studio.log'), ...optional('signal', input.signal) });
  } catch (error) {
    if (error instanceof Aborted) throw error;
    return { appStart: { gate: 'app-start', passed: false, summary: errorText(error) }, walks: skipped('walks', 'Studio did not start'), results: new Map() };
  }
  try {
    const allowlist = await allowWalker(input.runner, input.checkout);
    writeFileSync(join(input.logDir, 'allowlist.log'), allowlist);
    const appStart: GateResult = { gate: 'app-start', passed: true, summary: `Studio answered at ${app.url} in its sandbox`, output: allowlist };
    try {
      const studioSockets = await bridgeStudio(input);
      const results = await walkFromSandbox(input, studioSockets, app.url);
      const result = first === undefined ? undefined : results.get(first.label);
      const walks = result === undefined ? skipped('walks', 'no walk job ran') : walkGate(result, expected);
      return { appStart, walks, results, ...optional('result', result) };
    } catch (error) {
      if (input.signal?.aborted === true) throw new Aborted('the check was stopped during the walks');
      return { appStart, walks: { gate: 'walks', passed: false, summary: 'the walk runner failed', output: errorText(error) }, results: new Map() };
    }
  } finally {
    await app.stop();
  }
}
