import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_RULES_STORAGE_SCENARIOS,
  RULES_STORAGE_OBSERVATION_PREFIX,
  storageObservationName,
  type StorageScenario,
} from '../rules-corpus/storage/index.ts';
import {
  normalizeStoragePath,
  type StorageTestCase,
} from '../../pyric/src/rules/test/spec.ts';
import {
  parseStorageRules,
  type EvaluationInput,
  type FirestoreLookup,
} from '../../pyric/src/storage/sandbox/rules.ts';
import { evaluateStorageRules } from '../../pyric/src/storage/sandbox/rules-evaluator.ts';
import { storageRulesTestInputDigest } from './storage-rules-input-digest.ts';
import { loadStorageRulesExceptions } from './storage-rules-exceptions.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, '..', 'observations', 'storage-rules');

export interface StorageRulesObservation {
  name: string;
  rowIds?: string[];
  behavior: Record<string, unknown>;
  inputDigest?: { algorithm?: unknown; value?: unknown };
}

type Verdict = 'ALLOW' | 'DENY';

const KNOWN_EXCEPTIONS = loadStorageRulesExceptions();

function lookupFromCase(tc: StorageTestCase): FirestoreLookup | undefined {
  if (!tc.functionMocks || tc.functionMocks.length === 0) return undefined;
  const gets = new Map<string, Record<string, unknown>>();
  const exists = new Set<string>();
  for (const m of tc.functionMocks) {
    if (m.function === 'get' && typeof m.result === 'object' && m.result !== null) {
      gets.set(m.path, m.result as Record<string, unknown>);
    } else if (m.function === 'exists' && m.result === true) {
      exists.add(m.path);
    }
  }
  return {
    get: (path) => gets.get(path) ?? null,
    exists: (path) => exists.has(path),
  };
}

function toEvaluationInput(tc: StorageTestCase): EvaluationInput {
  const path = normalizeStoragePath(tc.path, tc.bucket);
  const request: EvaluationInput['request'] = {
    auth: tc.auth ?? null,
    method: tc.method,
    path,
  };
  if (tc.resource) {
    request.resource = {
      ...tc.resource,
      size: tc.resource.size ?? 0,
    };
  }
  const existing = tc.existingResource
    ? {
        size: tc.existingResource.size ?? 0,
        contentType: tc.existingResource.contentType,
        metadata: tc.existingResource.metadata,
        name: tc.existingResource.name,
        bucket: tc.existingResource.bucket,
        timeCreated: tc.existingResource.timeCreated,
        updated: tc.existingResource.updated,
        generation: tc.existingResource.generation,
        metageneration: tc.existingResource.metageneration,
      }
    : null;
  return { request, resource: existing };
}

export function evaluateStorageScenarioVerdicts(scenario: StorageScenario): Record<string, Verdict> {
  const rules = parseStorageRules(scenario.rules);
  const table: Record<string, Verdict> = {};
  for (const tc of scenario.cases) {
    const now = tc.requestTime ? new Date(tc.requestTime) : undefined;
    const res = evaluateStorageRules(rules, toEvaluationInput(tc), now, lookupFromCase(tc));
    table[tc.description] = res.allowed ? 'ALLOW' : 'DENY';
  }
  return table;
}

/** The observation and the corpus scenario must describe the same cases and inputs. */
function observationShapeProblems(scenario: StorageScenario, observation: StorageRulesObservation): string[] {
  const problems: string[] = [];
  const expectedKeys = scenario.cases.map(({ description }) => description).sort();
  const observedKeys = Object.keys(observation.behavior).sort();
  if (JSON.stringify(observedKeys) !== JSON.stringify(expectedKeys)) {
    problems.push(`${observation.name}: observation case set is stale`);
  }
  const expectedDigest = storageRulesTestInputDigest(scenario.rules, scenario.cases);
  if (JSON.stringify(observation.inputDigest) !== JSON.stringify(expectedDigest)) {
    problems.push(`${observation.name}: observation input digest is stale`);
  }
  return problems;
}

function pinRowProblems(key: string, observation: StorageRulesObservation, rowId: string): string[] {
  const linkedToRow = observation.rowIds?.includes(rowId) ?? false;
  return linkedToRow ? [] : [`${key}: divergence belongs to ${rowId}, which ${observation.name} does not cite`];
}

export function storageOracleReplayProblems(
  scenario: StorageScenario,
  observation: StorageRulesObservation,
  evaluatorVerdicts: Readonly<Record<string, Verdict>>,
  matchedDivergences?: Set<string>,
): string[] {
  const problems = observationShapeProblems(scenario, observation);
  const expectedKeys = scenario.cases.map(({ description }) => description).sort();
  const evalKeys = Object.keys(evaluatorVerdicts).sort();
  if (JSON.stringify(evalKeys) !== JSON.stringify(expectedKeys)) {
    problems.push(`${observation.name}: evaluator case set is not exact`);
  }

  const knownGap = new Set(
    scenario.cases.filter((c) => c.knownGap).map((c) => c.description),
  );

  for (const [caseKey, prodVerdict] of Object.entries(observation.behavior)) {
    if (knownGap.has(caseKey)) continue;
    const evalVerdict = evaluatorVerdicts[caseKey];
    const key = `${observation.name} :: ${caseKey}`;
    const known = KNOWN_EXCEPTIONS.get(key);
    if (known?.kind === 'verdict') {
      matchedDivergences?.add(key);
      problems.push(...pinRowProblems(key, observation, known.rowId));
      if (prodVerdict !== known.productionVerdict) {
        problems.push(`${key}: pinned production verdict changed`);
      }
      if (evalVerdict !== known.evaluatorVerdict) {
        problems.push(`${key}: pinned evaluator verdict changed (${known.issue}: ${known.reason})`);
      }
      continue;
    }
    if (evalVerdict !== prodVerdict) {
      problems.push(`${key}: production ${JSON.stringify(prodVerdict)}, evaluator ${JSON.stringify(evalVerdict)}`);
    }
  }
  return problems;
}

/**
 * A scenario pyric refuses to parse is pinned by its observation name. The pin
 * holds only while pyric still refuses it with the pinned error, and the
 * observation must still match the scenario's cases and inputs.
 */
export function storageParsePinProblems(
  scenario: StorageScenario,
  observation: StorageRulesObservation,
  error: Error,
  matchedDivergences?: Set<string>,
): string[] {
  const known = KNOWN_EXCEPTIONS.get(observation.name);
  if (known?.kind !== 'parse') return [`${observation.name}: evaluator failed: ${error.message}`];
  matchedDivergences?.add(observation.name);
  const problems = [
    ...observationShapeProblems(scenario, observation),
    ...pinRowProblems(observation.name, observation, known.rowId),
  ];
  if (!error.message.includes(known.localError)) {
    problems.push(`${observation.name}: pinned parse error changed (${known.issue}): ${error.message}`);
  }
  return problems;
}

/** Each scenario pinned as a parse divergence, with the error text pyric must still report. */
export function storageParsePins(): ReadonlyMap<string, string> {
  const pins = new Map<string, string>();
  for (const [key, known] of KNOWN_EXCEPTIONS) {
    if (known.kind === 'parse') pins.set(key, known.localError);
  }
  return pins;
}

export interface StorageOracleReplayResult {
  name: string;
  problems: string[];
}

export function replayStorageRulesObservations(): StorageOracleReplayResult[] {
  const scenarioByObservation = new Map(
    ALL_RULES_STORAGE_SCENARIOS.map((scenario) => [storageObservationName(scenario), scenario]),
  );
  const files = readdirSync(OBS_DIR)
    .filter((file) => file.startsWith(RULES_STORAGE_OBSERVATION_PREFIX) && file.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    return [{
      name: 'storage-rules-observation-set',
      problems: ['Storage Rules oracle replay has no committed observations'],
    }];
  }

  const replays: StorageOracleReplayResult[] = [];
  const matchedDivergences = new Set<string>();
  for (const file of files) {
    const observation = JSON.parse(readFileSync(join(OBS_DIR, file), 'utf8')) as StorageRulesObservation;
    observation.name ||= file.replace(/\.json$/, '');
    const scenario = scenarioByObservation.get(observation.name);
    if (!scenario) {
      replays.push({
        name: observation.name,
        problems: [`${observation.name}: no matching corpus scenario`],
      });
      continue;
    }
    let verdicts: Record<string, Verdict>;
    try {
      verdicts = evaluateStorageScenarioVerdicts(scenario);
    } catch (error) {
      replays.push({
        name: observation.name,
        problems: storageParsePinProblems(scenario, observation, error as Error, matchedDivergences),
      });
      continue;
    }
    replays.push({
      name: observation.name,
      problems: storageOracleReplayProblems(scenario, observation, verdicts, matchedDivergences),
    });
  }

  for (const key of KNOWN_EXCEPTIONS.keys()) {
    if (!matchedDivergences.has(key)) {
      replays.push({
        name: key,
        problems: [`${key}: stale or unused divergence pin`],
      });
    }
  }
  return replays;
}

/** Fail closed unless every committed Storage Rules production observation replays locally. */
export function assertStorageRulesOracleReplay(): void {
  const problems = replayStorageRulesObservations().flatMap(({ problems }) => problems);
  if (problems.length > 0) {
    throw new Error(`Storage Rules oracle replay failed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }
}
