/**
 * The gates that run inside the check's sandbox, in the check's checkout:
 * Studio's typecheck (as its CI runs it), its tests (`bun test test/studio`
 * at the repo root), its own ast-grep rule tests and scan, then the one
 * command start, the allowlist entry the walks sign in with, and the walks.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EgressNamespace } from '../namespace.ts';
import type { Checkout } from './app-paths.ts';
import { PYRIC_PORT, startApp, studioEnvironment, type StartedApp } from './app-start.ts';
import { runWalkJob, WALK_EMAIL } from './captures.ts';
import type { Run, Runner } from './exec.ts';
import { skipped, type GateName, type GateResult } from './gates.ts';
import type { WalkResult } from './walk-runner.ts';

const TYPECHECK_TIMEOUT_MS = 10 * 60_000;
const TESTS_TIMEOUT_MS = 15 * 60_000;
const AST_GREP_TIMEOUT_MS = 3 * 60_000;
const ALLOWLIST_TIMEOUT_MS = 2 * 60_000;

/** Runs `steps` in order and stops at the first failure; the gate's output is every step's. */
async function gate(runner: Runner, name: GateName, steps: readonly Run[]): Promise<GateResult> {
  let output = '';
  for (const step of steps) {
    const result = await runner(step);
    output += `$ ${step.command} ${step.args.join(' ')}\n${result.output}\n`;
    const failed = result.code !== 0 || result.timedOut;
    if (failed) return { gate: name, passed: false, summary: `${step.args.slice(0, 2).join(' ') || step.command} exited ${result.code}${result.timedOut ? ' (timed out)' : ''}`, output };
  }
  return { gate: name, passed: true, summary: 'passed', output };
}

export async function staticGates(runner: Runner, checkout: Checkout, astGrep: string): Promise<GateResult[]> {
  const studio = checkout.studio;
  const typecheck = await gate(runner, 'typecheck', [
    { command: 'node', args: ['node_modules/next/dist/bin/next', 'typegen'], cwd: studio, timeoutMs: TYPECHECK_TIMEOUT_MS },
    { command: 'node', args: ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false'], cwd: studio, timeoutMs: TYPECHECK_TIMEOUT_MS },
  ]);
  const tests = await gate(runner, 'tests', [{ command: 'bun', args: ['test', 'test/studio'], cwd: checkout.repo, timeoutMs: TESTS_TIMEOUT_MS }]);
  const checks = await gate(runner, 'studio-checks', [
    { command: astGrep, args: ['test', '-c', 'checks/sgconfig.yml'], cwd: studio, timeoutMs: AST_GREP_TIMEOUT_MS },
    { command: astGrep, args: ['scan', '-c', 'checks/sgconfig.yml'], cwd: studio, timeoutMs: AST_GREP_TIMEOUT_MS },
  ]);
  return [typecheck, tests, checks];
}

export interface WalkRun {
  appStart: GateResult;
  walks: GateResult;
  result?: WalkResult;
}

export interface WalkRunInput {
  runner: Runner;
  namespace: EgressNamespace;
  checkout: Checkout;
  logDir: string;
  walksDir: string;
  walks: readonly string[];
  routes?: readonly string[];
  outDir: string;
}

/** Adds the walks' account to Studio's allowlist in the running sandbox: Studio signs out anyone not on it. */
async function allowWalker(runner: Runner, checkout: Checkout): Promise<string> {
  const env = { ...studioEnvironment({ checkout }), PYRIC_SANDBOX: `remote:http://127.0.0.1:${PYRIC_PORT}` };
  const result = await runner({ command: 'node', args: ['scripts/allowlist.mjs', 'add', WALK_EMAIL, '--local'], cwd: checkout.studio, timeoutMs: ALLOWLIST_TIMEOUT_MS, env });
  return `allowlist add ${WALK_EMAIL} --local: exit ${result.code}\n${result.output}`;
}

function walkGate(result: WalkResult, expected: number): GateResult {
  const failing = result.walks.filter((walk) => !walk.passed);
  const output = failing.map((walk) => `${walk.name}:\n${walk.error ?? ''}`).join('\n\n');
  if (expected === 0) return { gate: 'walks', passed: false, summary: 'the brief has no walk scripts' };
  if (failing.length > 0) return { gate: 'walks', passed: false, summary: `${failing.length} of ${expected} walks failed: ${failing.map((walk) => walk.name).join(', ')}`, output };
  return { gate: 'walks', passed: true, summary: `${expected} walks passed` };
}

/** Starts Studio, walks it and captures its pages, then stops it. */
export async function startAndWalk(input: WalkRunInput): Promise<WalkRun> {
  let app: StartedApp;
  try {
    app = await startApp({ checkout: input.checkout, namespace: input.namespace, logFile: join(input.logDir, 'studio.log') });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { appStart: { gate: 'app-start', passed: false, summary: message }, walks: skipped('walks', 'Studio did not start') };
  }
  try {
    const allowlist = await allowWalker(input.runner, input.checkout);
    writeFileSync(join(input.logDir, 'allowlist.log'), allowlist);
    const result = await runWalkJob({ runner: input.runner, stageRoot: join(input.checkout.root, 'walk-stage'), baseURL: app.url, walksDir: input.walksDir, walks: input.walks, routes: input.routes ?? [], outDir: input.outDir });
    const walks = walkGate(result, input.walks.length);
    return { appStart: { gate: 'app-start', passed: true, summary: `Studio answered at ${app.url} in the sandbox`, output: allowlist }, walks, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { appStart: { gate: 'app-start', passed: true, summary: 'Studio started' }, walks: { gate: 'walks', passed: false, summary: 'the walk runner failed', output: message } };
  } finally {
    await app.stop();
  }
}
