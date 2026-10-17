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
 * Evaluation runs in a short-lived `node:worker_threads` Worker so each call
 * gets a fresh ESM module map on both Bun and Node 22+:
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

import { resolve as resolvePath } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  checkRtdbRules,
  compileRtdbRules,
  simulateRtdbRules,
  type CompiledRtdbRules,
  type RtdbRulesCheckResult,
  type RtdbRulesDocument,
  type RtdbRulesJson,
  type RtdbRulesSimulationAuth,
  type RtdbRulesSimulationInput,
  type SimulateResult,
  type SimulationInput,
} from 'pyric/rules/internal/rtdb';
import { isRtdbRulesDocument } from './rules-json.js';

export interface LoadRtdbRulesDocumentOptions {
  cwd?: string;
  /** Named export to look for before falling back to `default`. Defaults to `rules`. */
  exportName?: string;
}

export type LoadRtdbRulesDocumentResult =
  | { ok: true; document: RtdbRulesDocument }
  | { ok: false; message: string };

type WorkerEvaluationOutcome =
  | { status: 'loaded'; json: RtdbRulesJson }
  | { status: 'invalid-export' }
  | { status: 'import-error'; detail: string };

const WORKER_EVAL_SCRIPT = `
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractRulesJson(candidate) {
  if (!isPlainObject(candidate) || typeof candidate.toJSON !== 'function') {
    return null;
  }
  try {
    const json = candidate.toJSON();
    if (isPlainObject(json) && isPlainObject(json.rules)) {
      return json;
    }
    return null;
  } catch {
    return null;
  }
}

const { resolved, exportName } = workerData;
try {
  const resolvedEntry = createRequire(resolved).resolve(resolved);
  const mod = await import(pathToFileURL(resolvedEntry).href);
  const namedJson = extractRulesJson(mod[exportName]);
  if (namedJson !== null) {
    parentPort.postMessage({ status: 'loaded', json: namedJson });
  } else {
    const defaultJson = extractRulesJson(mod.default);
    if (defaultJson !== null) {
      parentPort.postMessage({ status: 'loaded', json: defaultJson });
    } else {
      parentPort.postMessage({ status: 'invalid-export' });
    }
  }
} catch (error) {
  let detail = String(error);
  if (error instanceof Error) {
    detail = error.message;
  }
  parentPort.postMessage({ status: 'import-error', detail });
}
`;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeAuth(auth: RtdbRulesSimulationAuth | undefined): SimulationInput['auth'] {
  if (auth === undefined || auth === null) return null;
  if (typeof auth === 'string') return { uid: auth, token: {} };
  const normalized: NonNullable<SimulationInput['auth']> = {
    uid: auth.uid,
    token: auth.token ?? {},
  };
  if (auth.tenant !== undefined) normalized.tenant = auth.tenant;
  return normalized;
}

function toSimulationInput(input: RtdbRulesSimulationInput): SimulationInput {
  const simulation: SimulationInput = {
    operation: input.operation,
    path: input.path,
    auth: normalizeAuth(input.auth),
    mockData: input.mockData ?? input.data ?? {},
  };
  if (input.newData !== undefined) simulation.newData = input.newData;
  if (input.now !== undefined) simulation.now = input.now;
  if (input.updates !== undefined) simulation.updates = input.updates;
  if (input.query !== undefined) simulation.query = input.query;
  return simulation;
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
    return simulateRtdbRules(this.compile(), toSimulationInput(input));
  }
}

function evaluateRulesModuleInWorker(
  resolved: string,
  exportName: string,
): Promise<WorkerEvaluationOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_EVAL_SCRIPT, {
      eval: true,
      workerData: { resolved, exportName },
    });

    const finish = (outcome: WorkerEvaluationOutcome): void => {
      if (settled) return;
      settled = true;
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
  const resolved = resolvePath(cwd, configPath);

  const outcome = await evaluateRulesModuleInWorker(resolved, exportName);
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
