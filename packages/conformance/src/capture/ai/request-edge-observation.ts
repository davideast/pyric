/**
 * Writes `ai-request-edge-` observations in the observations/ai/ house format
 * (the shape src/ai-probes.ts writes), with rowIds taken from the registry
 * rows that cite each capture. Response facts are deterministic: status,
 * error envelope, finish reason, roles and part key sets. Generated text is
 * never stored. The writer redacts and refuses any file that still contains
 * the API key, app id or App Check token.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvedFirebaseVersion } from '../../package-version.ts';
import { assertNoSecret, citingRowIds } from '../app-check/observation-writer.ts';
import { redactJson, type Secrets } from '../app-check/redact.ts';
import type { RequestEdgeCase } from './request-edge-cases.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, '..', '..', '..', 'observations', 'ai');
export const API_VERSION = 'v1beta';

export interface RawResult {
  status: number;
  body: unknown;
}

type ErrorEnvelope = { error?: { code?: number; message?: string; status?: string; details?: unknown[] } };
type Part = Record<string, unknown>;
type Candidate = { finishReason?: string; content?: { role?: string; parts?: Part[] } };

const sortedKeys = (value: unknown): string[] => (value && typeof value === 'object' ? Object.keys(value).sort() : []);

function detailTypes(details: unknown[] | undefined): string[] {
  if (!Array.isArray(details)) return [];
  return [...new Set(details.map((d) => (d as { '@type'?: string })['@type'] ?? 'unknown'))].sort();
}

/** The same error facts src/ai-probes.ts records, plus the raw error envelope. */
function errorFacts(result: RawResult) {
  const error = (result.body as ErrorEnvelope | null)?.error;
  return {
    errorKeySet: sortedKeys(error),
    errorCode: error?.code,
    errorStatus: error?.status,
    detailTypes: detailTypes(error?.details),
    messageText: error?.message,
    raw: result.body,
  };
}

/** Shape-only success facts: no text, no thought signatures. */
function successFacts(result: RawResult) {
  const body = result.body as { candidates?: Candidate[] } | null;
  const candidate = body?.candidates?.[0];
  return {
    topLevelKeySet: sortedKeys(body),
    candidateCount: body?.candidates?.length ?? 0,
    finishReason: candidate?.finishReason ?? null,
    contentRole: candidate?.content?.role ?? null,
    partKeySets: (candidate?.content?.parts ?? []).map((part) => sortedKeys(part)),
  };
}

export function responseFacts(result: RawResult) {
  const succeeded = result.status === 200;
  return {
    httpStatus: result.status,
    isJson: result.body !== null,
    ...(succeeded ? successFacts(result) : errorFacts(result)),
  };
}

export interface EdgeObservationContext {
  projectId: string;
  secrets: Secrets;
}

export function writeEdgeObservation(
  context: EdgeObservationContext,
  testCase: RequestEdgeCase,
  behavior: Record<string, unknown>,
): void {
  const observation = {
    name: testCase.name,
    matrixRow: '',
    rowIds: citingRowIds(testCase.name),
    description: testCase.description,
    observedAt: new Date().toISOString(),
    fbSdkVersion: resolvedFirebaseVersion(),
    projectId: context.projectId,
    apiVersion: API_VERSION,
    model: testCase.model,
    behavior: redactJson(behavior, context.secrets),
  };
  const serialized = `${JSON.stringify(observation, null, 2)}\n`;
  assertNoSecret(serialized, context.secrets, testCase.name);
  mkdirSync(OBS_DIR, { recursive: true });
  writeFileSync(join(OBS_DIR, `${testCase.name}.json`), serialized);
  console.log(`wrote ${testCase.name}`);
}
