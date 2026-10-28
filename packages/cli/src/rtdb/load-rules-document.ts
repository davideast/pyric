/**
 * Loads a user's RTDB constraints module (a file that calls
 * `defineRtdbRules(...)` from `pyric/rules`) so the CLI and MCP
 * `generate` surfaces can turn it into static rules JSON without
 * reimplementing compilation — the loaded document's `.toJSON()` still
 * routes through the pure RTDB rules compiler.
 *
 * The module may export the `RtdbRulesDocument` as its default export
 * or as a named `rules` export.
 *
 * Evaluation runs in a short-lived `node:worker_threads` Worker module
 * (`./load-rules-document.worker.js`) so each call gets a fresh ESM module map
 * on both Bun and Node 22+:
 * - Bun caches `file://` ESM modules by canonical path (`realpath`) and
 *   ignores query-string cache busters (`?t=...`).
 * - Node busts the entry module on query strings, but any relative import
 *   inside the entry module (e.g. `import { ... } from './shared.ts'`) still
 *   resolves to its un-busted canonical URL in the current realm's ESM cache.
 * - Copying only the entry file to a temp path fails on relative imports for
 *   the same reason, and writing temp files into the project tree triggers
 *   file watchers (`pyric sandbox`, Vite) and risks orphaned files on crash.
 * A dedicated Worker evaluates the module and its full transitive import graph
 * from disk with zero filesystem side effects and releases the module cache
 * when terminated.
 */

import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
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
import type {
  LoadRulesWorkerInput,
  WorkerEvaluationOutcome,
} from './load-rules-document.worker.js';
import { isRtdbRulesDocument } from './rules-json.js';

const DEFAULT_EVAL_TIMEOUT_MS = 30_000;

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

function resolveWorkerModuleUrl(): URL {
  const builtUrl = new URL('./load-rules-document.worker.js', import.meta.url);
  if (existsSync(fileURLToPath(builtUrl))) {
    return builtUrl;
  }
  return new URL('./load-rules-document.worker.ts', import.meta.url);
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

function evaluateRulesModuleInWorker(
  input: LoadRulesWorkerInput,
  timeoutMs: number,
): Promise<WorkerEvaluationOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(resolveWorkerModuleUrl(), {
      workerData: input,
    });

    const timer = setTimeout(() => {
      finish({
        status: 'import-error',
        detail: `evaluation timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    timer.unref?.();

    const finish = (outcome: WorkerEvaluationOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    };

    worker.on('message', (message: WorkerEvaluationOutcome) => {
      finish(message);
    });
    worker.on('error', (error: unknown) => {
      finish({ status: 'import-error', detail: errorMessage(error) });
    });
    worker.on('exit', (code: number) => {
      finish({
        status: 'import-error',
        detail: `worker exited with code ${code} before returning a rules document`,
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

  const outcome = await evaluateRulesModuleInWorker({ resolved, exportName }, timeoutMs);
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
