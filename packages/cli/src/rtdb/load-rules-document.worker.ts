import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { RtdbRulesJson } from 'pyric/rules/internal/rtdb';

export const RTDB_RULES_CHILD_INPUT_ENV = 'PYRIC_RTDB_RULES_CHILD_INPUT';

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractRulesJson(value: unknown): RtdbRulesJson | null {
  if (!isPlainObject(value) || typeof value.toJSON !== 'function') {
    return null;
  }
  try {
    const json = (value as { toJSON(): unknown }).toJSON();
    if (isPlainObject(json) && isPlainObject(json.rules)) {
      return json as unknown as RtdbRulesJson;
    }
    return null;
  } catch {
    return null;
  }
}

let started = false;
let outcomeSent = false;
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

function sendOutcome(outcome: WorkerEvaluationOutcome): void {
  if (outcomeSent || typeof process.send !== 'function') {
    return;
  }
  outcomeSent = true;
  process.send(outcome, () => {
    if (keepAliveTimer !== undefined) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = undefined;
    }
    process.exit(0);
  });
}

async function evaluateModule(rawInput: string): Promise<void> {
  try {
    const { resolved, exportName } = JSON.parse(rawInput) as LoadRulesWorkerInput;
    const resolvedEntry = createRequire(resolved).resolve(resolved);
    const mod = (await import(pathToFileURL(resolvedEntry).href)) as Record<string, unknown>;

    const namedJson = extractRulesJson(mod[exportName]);
    if (namedJson !== null) {
      sendOutcome({ status: 'loaded', json: namedJson });
      return;
    }

    const defaultJson = extractRulesJson(mod.default);
    if (defaultJson !== null) {
      sendOutcome({ status: 'loaded', json: defaultJson });
      return;
    }

    sendOutcome({ status: 'invalid-export' });
  } catch (error) {
    sendOutcome({
      status: 'import-error',
      detail: errorMessage(error),
    });
  }
}

export function startLoadRtdbRulesDocumentWorker(): void {
  const rawInput = process.env[RTDB_RULES_CHILD_INPUT_ENV];
  if (started || !rawInput || typeof process.send !== 'function') {
    return;
  }
  started = true;
  delete process.env[RTDB_RULES_CHILD_INPUT_ENV];
  keepAliveTimer = setInterval(() => {}, 60_000);

  const onFatalError = (error: unknown): void => {
    sendOutcome({ status: 'import-error', detail: errorMessage(error) });
  };
  process.on('uncaughtException', onFatalError);
  process.on('unhandledRejection', onFatalError);

  void evaluateModule(rawInput);
}

startLoadRtdbRulesDocumentWorker();
