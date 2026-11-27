import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateStorageRules } from '../../../rules/src/storage/rules-evaluator.ts';
import {
  parseStorageRules,
  type EvaluationInput,
  type FirestoreLookup,
} from '../../../rules/src/storage/rules.ts';
import {
  buildStorageApiTestCase,
  normalizeStoragePath,
  type StorageTestCase,
} from '../../../rules/src/test/spec.ts';
import { scenario as authoredScenario } from '../../rules-corpus/storage/h1-lookup-float-interpolation.ts';
import { ALL_RULES_STORAGE_SCENARIOS, storageObservationName } from '../../rules-corpus/storage/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_PATH = join(
  HERE,
  '..',
  '..',
  'observations',
  'storage-rules',
  'rules-storage-h1-lookup-float-interpolation.json',
);

function buildOfflineLookup(tc: StorageTestCase): FirestoreLookup | undefined {
  if (!tc.functionMocks || tc.functionMocks.length === 0) {
    return undefined;
  }
  const gets = new Map<string, Record<string, unknown>>();
  const exists = new Set<string>();
  for (const mock of tc.functionMocks) {
    if (mock.function === 'get' && typeof mock.result === 'object' && mock.result !== null) {
      gets.set(mock.path, mock.result);
    } else if (mock.function === 'exists' && mock.result === true) {
      exists.add(mock.path);
    }
  }
  return {
    get: (path) => gets.get(path) ?? null,
    exists: (path) => exists.has(path),
  };
}

function toOfflineInput(tc: StorageTestCase): EvaluationInput {
  const request: EvaluationInput['request'] = {
    auth: tc.auth ?? null,
    method: tc.method,
    path: normalizeStoragePath(tc.path, tc.bucket),
  };
  if (tc.resource) {
    request.resource = {
      size: tc.resource.size ?? 0,
      contentType: tc.resource.contentType,
      metadata: tc.resource.metadata,
    };
  }
  return {
    request,
    resource: null,
  };
}

describe('h1-lookup-float-interpolation linked Storage rules-corpus probe (#1815)', () => {
  const scenario = ALL_RULES_STORAGE_SCENARIOS.find(
    (entry) => entry.id === 'h1-lookup-float-interpolation',
  );

  it('loads from rules-corpus/storage linked to storage-rules#115 with pendingRowLink dropped', () => {
    expect(scenario).toBeDefined();
    if (!scenario) return;
    expect(scenario).toMatchObject(authoredScenario);
    expect(scenario.pendingRowLink).toBeUndefined();
    expect(storageObservationName(scenario)).toBe('rules-storage-h1-lookup-float-interpolation');
    expect(scenario.cases).toHaveLength(8);
    const obs = JSON.parse(readFileSync(OBS_PATH, 'utf8')) as {
      matrixRow: string;
      rowIds: string[];
    };
    expect(obs.matrixRow).toBe('storage-rules#115');
    expect(obs.rowIds).toEqual(['storage-rules#115']);
  });

  it('matches all 8 captured production verdicts offline against pyric', () => {
    if (scenario === undefined) throw new Error('missing scenario h1-lookup-float-interpolation');
    const obs = JSON.parse(readFileSync(OBS_PATH, 'utf8')) as {
      behavior: Record<string, 'ALLOW' | 'DENY'>;
    };
    const parsed = parseStorageRules(scenario.rules);
    const verdicts: Record<string, 'ALLOW' | 'DENY'> = {};
    for (const tc of scenario.cases) {
      const result = evaluateStorageRules(parsed, toOfflineInput(tc), undefined, buildOfflineLookup(tc));
      verdicts[tc.description] = result.allowed ? 'ALLOW' : 'DENY';
    }
    expect(verdicts).toEqual(obs.behavior);
  });

  it('serializes float 1.5 and int 7 wire values cleanly', () => {
    if (!scenario) throw new Error('missing scenario h1-lookup-float-interpolation');
    const wireCases = scenario.cases.map((tc) => buildStorageApiTestCase(tc));
    expect(wireCases[0]?.request.auth?.token).toEqual({ v: 1.5 });
    expect(wireCases[1]?.request.auth?.token).toEqual({ v: 7 });
    expect(wireCases[4]?.functionMocks?.[0]).toEqual({
      function: 'firestore.get',
      args: [{ exactValue: '/databases/(default)/documents/cfg/main' }],
      result: { value: { data: { v: 1.5 } } },
    });
    expect(wireCases[5]?.functionMocks?.[0]).toEqual({
      function: 'firestore.get',
      args: [{ exactValue: '/databases/(default)/documents/cfg/main' }],
      result: { value: { data: { v: 7 } } },
    });
  });
});
