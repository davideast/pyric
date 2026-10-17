import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { RtdbRulesJson } from 'pyric/rules/internal/rtdb';
import { isRtdbRulesDocument } from './rules-json.js';

export interface LoadRulesWorkerInput {
  resolved: string;
  exportName: string;
}

export type WorkerEvaluationOutcome =
  | { status: 'loaded'; json: RtdbRulesJson }
  | { status: 'invalid-export' }
  | { status: 'import-error'; detail: string };

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function evaluateModule(): Promise<void> {
  const { resolved, exportName } = workerData as LoadRulesWorkerInput;
  try {
    const resolvedEntry = createRequire(resolved).resolve(resolved);
    const mod = (await import(pathToFileURL(resolvedEntry).href)) as Record<string, unknown>;

    const namedCandidate = mod[exportName];
    if (isRtdbRulesDocument(namedCandidate)) {
      const outcome: WorkerEvaluationOutcome = {
        status: 'loaded',
        json: namedCandidate.toJSON(),
      };
      parentPort?.postMessage(outcome);
      return;
    }

    const defaultCandidate = mod.default;
    if (isRtdbRulesDocument(defaultCandidate)) {
      const outcome: WorkerEvaluationOutcome = {
        status: 'loaded',
        json: defaultCandidate.toJSON(),
      };
      parentPort?.postMessage(outcome);
      return;
    }

    const invalidOutcome: WorkerEvaluationOutcome = { status: 'invalid-export' };
    parentPort?.postMessage(invalidOutcome);
  } catch (error) {
    const errorOutcome: WorkerEvaluationOutcome = {
      status: 'import-error',
      detail: errorMessage(error),
    };
    parentPort?.postMessage(errorOutcome);
  }
}

let started = false;

export function startLoadRtdbRulesDocumentWorker(): void {
  if (started || isMainThread || !workerData) {
    return;
  }
  started = true;
  void evaluateModule();
}

startLoadRtdbRulesDocumentWorker();
