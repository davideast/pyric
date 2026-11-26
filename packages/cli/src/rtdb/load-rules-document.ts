/**
 * Loads a user's RTDB constraints module (a file that calls
 * `defineRtdbRules(...)` from `pyric/rules`) so the CLI and MCP
 * `generate` surfaces can turn it into static rules JSON without
 * reimplementing compilation -- the loaded document's `.toJSON()` still
 * routes through the pure RTDB rules compiler.
 *
 * The module may export the `RtdbRulesDocument` as its default export
 * or as a named `rules` export.
 *
 * Evaluation runs in a short-lived child process (`./load-rules-document.worker.js`)
 * over IPC so each call gets a fresh ESM module map and isolated address space
 * on Bun, Node 22+, and standalone compiled binaries:
 * - Bun caches `file://` ESM modules by canonical path (`realpath`) and
 *   ignores query-string cache busters (`?t=...`).
 * - Node busts the entry module on query strings, but any relative import
 *   inside the entry module (e.g. `import { ... } from './shared.ts'`) still
 *   resolves to its un-busted canonical URL in the current realm's ESM cache.
 * - Terminating an in-process `node:worker_threads` Worker under Bun while
 *   `RuntimeTranspilerStore` background transpilation jobs are still writing to
 *   the worker VM's `SavedSourceMap` triggers a native use-after-deinit crash
 *   in the host process (#3411).
 * A dedicated child process evaluates the module and its full transitive import
 * graph from disk with zero filesystem side effects and is reaped by the OS
 * before `loadRtdbRulesDocument` resolves.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkRtdbRules,
  compileRtdbRules,
  normalizeSimulationInput,
  simulateRtdbRules,
  type CompiledRtdbRules,
  type RtdbRulesCheckResult,
  type RtdbRulesDocument,
  type RtdbRulesJson,
  type RtdbRulesSimulationInput,
  type SimulateResult,
} from 'pyric/rules/internal/rtdb';
import {
  RTDB_RULES_CHILD_INPUT_ENV,
  type LoadRulesWorkerInput,
  type WorkerEvaluationOutcome,
} from './load-rules-document.worker.js';
import { isRtdbRulesDocument } from './rules-json.js';

const DEFAULT_EVAL_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 8_192;

const FORWARDED_NODE_VALUE_FLAGS = new Set([
  '--conditions',
  '-C',
  '--experimental-loader',
  '--import',
  '--loader',
  '--require',
  '-r',
]);

const FORWARDED_NODE_BOOLEAN_FLAGS = new Set([
  '--experimental-strip-types',
  '--experimental-transform-types',
  '--no-experimental-strip-types',
  '--no-warnings',
  '--preserve-symlinks',
  '--preserve-symlinks-main',
]);

export interface LoadRtdbRulesDocumentOptions {
  cwd?: string;
  /** Named export to look for before falling back to `default`. Defaults to `rules`. */
  exportName?: string;
  /** Maximum time in milliseconds to wait for the module to evaluate. Defaults to 30,000. */
  timeoutMs?: number;
}

export type LoadRtdbRulesDocumentResult =
  | { ok: true; document: RtdbRulesDocument }
  | { ok: false; message: string };

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function resolveWorkerModulePath(): string {
  const builtPath = fileURLToPath(new URL('./load-rules-document.worker.js', import.meta.url));
  if (existsSync(builtPath)) {
    return builtPath;
  }
  return fileURLToPath(new URL('./load-rules-document.worker.ts', import.meta.url));
}

function isStandaloneBinary(): boolean {
  return Boolean((globalThis as { __PYRIC_EMBEDDED__?: unknown }).__PYRIC_EMBEDDED__);
}

function childRuntimeExecArgv(): string[] {
  if (process.versions.bun) {
    return [];
  }

  const forwarded: string[] = [];
  let hasCustomLoaderOrStripSetting = false;

  for (let i = 0; i < process.execArgv.length; i += 1) {
    const arg = process.execArgv[i] ?? '';
    if (FORWARDED_NODE_VALUE_FLAGS.has(arg)) {
      forwarded.push(arg);
      const next = process.execArgv[i + 1];
      if (next !== undefined) {
        forwarded.push(next);
        i += 1;
      }
      if (arg === '--loader' || arg === '--experimental-loader') {
        hasCustomLoaderOrStripSetting = true;
      }
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const flagName = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    if (FORWARDED_NODE_VALUE_FLAGS.has(flagName) || FORWARDED_NODE_BOOLEAN_FLAGS.has(flagName)) {
      forwarded.push(arg);
      if (
        flagName === '--loader'
        || flagName === '--experimental-loader'
        || flagName === '--experimental-strip-types'
        || flagName === '--experimental-transform-types'
        || flagName === '--no-experimental-strip-types'
      ) {
        hasCustomLoaderOrStripSetting = true;
      }
    }
  }

  const nodeOptions = process.env.NODE_OPTIONS ?? '';
  if (
    nodeOptions.includes('--loader')
    || nodeOptions.includes('--experimental-loader')
    || nodeOptions.includes('--no-experimental-strip-types')
  ) {
    hasCustomLoaderOrStripSetting = true;
  }

  const nativeTs = (process.features as { typescript?: string | boolean }).typescript;
  if (!nativeTs && !hasCustomLoaderOrStripSetting) {
    forwarded.push('--no-warnings=ExperimentalWarning', '--experimental-strip-types');
  }

  return forwarded;
}

class LoadedRtdbRulesDocument implements RtdbRulesDocument {
  private compiled: CompiledRtdbRules | undefined;

  constructor(private readonly json: RtdbRulesJson) {}

  toJSON(): RtdbRulesJson {
    return this.json;
  }

  compile(): CompiledRtdbRules {
    this.compiled ??= compileRtdbRules(this.json);
    return this.compiled;
  }

  check(): RtdbRulesCheckResult {
    return checkRtdbRules(() => this.compile());
  }

  simulate(input: RtdbRulesSimulationInput): SimulateResult {
    return simulateRtdbRules(this.compile(), normalizeSimulationInput(input));
  }
}

function evaluateRulesModuleInChild(
  input: LoadRulesWorkerInput,
  cwd: string,
  timeoutMs: number,
): Promise<WorkerEvaluationOutcome> {
  return new Promise((resolve) => {
    let finished = false;
    let outcome: WorkerEvaluationOutcome | undefined;
    let stderr = '';

    const args = isStandaloneBinary()
      ? []
      : [...childRuntimeExecArgv(), resolveWorkerModulePath()];
    const spawnCwd = existsSync(cwd) ? cwd : undefined;
    const child = spawn(process.execPath, args, {
      cwd: spawnCwd,
      env: {
        ...process.env,
        [RTDB_RULES_CHILD_INPUT_ENV]: JSON.stringify(input),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr = `${stderr}${chunk}`.slice(0, MAX_STDERR_BYTES);
      }
    });

    const killChild = (): void => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Child already exited between check and signal.
        }
      }
    };

    const keepAlive = setInterval(() => {}, 60_000);

    const finish = (result: WorkerEvaluationOutcome): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(keepAlive);
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (outcome !== undefined) return;
      outcome = {
        status: 'import-error',
        detail: `evaluation timed out after ${timeoutMs}ms`,
      };
      killChild();
    }, timeoutMs);

    child.on('message', (message: WorkerEvaluationOutcome) => {
      if (outcome !== undefined) return;
      outcome = message;
      clearTimeout(timer);
      killChild();
    });

    child.on('error', (error: unknown) => {
      if (outcome === undefined) {
        outcome = { status: 'import-error', detail: errorMessage(error) };
      }
      finish(outcome);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (outcome !== undefined) {
        finish(outcome);
        return;
      }
      const detail = stderr.trim();
      const exitDesc = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      finish({
        status: 'import-error',
        detail: detail.length > 0
          ? detail
          : `worker exited with ${exitDesc} before returning a rules document`,
      });
    });
  });
}

export async function loadRtdbRulesDocument(
  configPath: string,
  options: LoadRtdbRulesDocumentOptions = {},
): Promise<LoadRtdbRulesDocumentResult> {
  const cwd = options.cwd ?? process.cwd();
  const exportName = options.exportName ?? 'rules';
  const timeoutMs = options.timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
  const resolved = resolvePath(cwd, configPath);

  const outcome = await evaluateRulesModuleInChild({ resolved, exportName }, cwd, timeoutMs);
  if (outcome.status === 'import-error') {
    return {
      ok: false,
      message: `failed to load RTDB constraints module at ${resolved}: ${outcome.detail}`,
    };
  }

  if (outcome.status === 'loaded') {
    const document = new LoadedRtdbRulesDocument(outcome.json);
    if (isRtdbRulesDocument(document)) {
      return { ok: true, document };
    }
  }

  return {
    ok: false,
    message:
      `${resolved} does not export an RtdbRulesDocument (looked for a named ` +
      `'${exportName}' export or a default export produced by defineRtdbRules(...)).`,
  };
}
