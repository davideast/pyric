/**
 * Runs the real-database sibling-merge probe (row firestore-rules#190) through
 * pyric's LocalEnvironment with the same rules, seed and writes, and compares
 * the verdicts with the production-database capture.
 *
 * The corpus case the oracle replay pairs with this observation is a single
 * create with a `get` mock, so it passes whatever pyric's batch merge does.
 * This test is the one that fails when a batch update stops keeping the
 * companion's untouched fields in getAfter().
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalEnvironment } from '../../../pyric/src/sandbox/internal/index.ts';
import { injectFirestoreProbeRules } from '../../src/firestore-real-rules.ts';
import {
  assertGetAfterProbeControls,
  siblingMergeProbePlan,
  type ProbeVerdict,
  type ProbeWrite,
  type SiblingMergeVerdicts,
} from '../../src/firestore-real-sibling-merge.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSERVATION_PATH = join(
  HERE,
  '..',
  '..',
  'observations',
  'firestore-rules',
  'rules-firestore-atomic-batch-sibling-merge.json',
);

const BASE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
  }
}
`;

const RUN_ID = 'local-replay';
const AUTH = { uid: `pyric-browser-${RUN_ID}` };

/**
 * What a real database answers, used only until the first production-database
 * capture lands. After that the recorded verdicts replace it.
 */
const EXPECTED_BEFORE_CAPTURE: SiblingMergeVerdicts = {
  soloPrimary: 'DENY',
  batch: 'ALLOW',
  fullBatch: 'ALLOW',
};

interface RecordedProductionDatabase {
  siblingMergeBatch: ProbeVerdict;
  siblingMergeSoloPrimary: ProbeVerdict;
  siblingMergeFullBatch?: ProbeVerdict;
}

function recordedProductionDatabase(): RecordedProductionDatabase | null {
  const observation = JSON.parse(readFileSync(OBSERVATION_PATH, 'utf8')) as {
    diagnostics?: { productionDatabase?: RecordedProductionDatabase };
  };
  return observation.diagnostics?.productionDatabase ?? null;
}

function toVerdict(allowed: boolean): ProbeVerdict {
  return allowed ? 'ALLOW' : 'DENY';
}

function runLocally(): SiblingMergeVerdicts {
  const plan = siblingMergeProbePlan(RUN_ID);
  const env = new LocalEnvironment();
  env.seed({ rules: injectFirestoreProbeRules(BASE_RULES, RUN_ID), documents: plan.seed });
  const batch = (writes: ProbeWrite[]) => toVerdict(env.batch(writes, AUTH).allowed);
  const soloPrimary = toVerdict(env.execute({ ...plan.soloPrimary, auth: AUTH }).allowed);
  return {
    soloPrimary,
    batch: batch(plan.batch),
    fullBatch: batch(plan.fullBatch),
  };
}

describe('firestore-rules#190 sibling-merge probe through LocalEnvironment', () => {
  const local = runLocally();
  const recorded = recordedProductionDatabase();

  it('matches the production-database verdicts for the batch and the solo control', () => {
    const expected = recorded
      ? { soloPrimary: recorded.siblingMergeSoloPrimary, batch: recorded.siblingMergeBatch }
      : { soloPrimary: EXPECTED_BEFORE_CAPTURE.soloPrimary, batch: EXPECTED_BEFORE_CAPTURE.batch };
    expect({ soloPrimary: local.soloPrimary, batch: local.batch }).toEqual(expected);
  });

  it('matches the production-database verdict for the batch that updates both fields', () => {
    const expected = recorded?.siblingMergeFullBatch ?? EXPECTED_BEFORE_CAPTURE.fullBatch;
    expect(local.fullBatch).toBe(expected);
  });

  it('passes the capture writer control checks', () => {
    expect(() => assertGetAfterProbeControls({
      rulesGetAfterSoloPrimary: 'DENY',
      rulesGetAfterSiblingMergeSoloPrimary: local.soloPrimary,
      rulesGetAfterSiblingMergeFullBatch: local.fullBatch,
    })).not.toThrow();
  });
});

describe('capture writer control checks', () => {
  const passing = {
    rulesGetAfterSoloPrimary: 'DENY',
    rulesGetAfterSiblingMergeSoloPrimary: 'DENY',
    rulesGetAfterSiblingMergeFullBatch: 'ALLOW',
  };

  it('refuses a capture whose cross-document solo control allowed', () => {
    expect(() => assertGetAfterProbeControls({ ...passing, rulesGetAfterSoloPrimary: 'ALLOW' }))
      .toThrow('rulesGetAfterSoloPrimary control answered "ALLOW", expected DENY');
  });

  it('refuses a capture whose sibling-merge solo control allowed', () => {
    expect(() => assertGetAfterProbeControls({ ...passing, rulesGetAfterSiblingMergeSoloPrimary: 'ALLOW' }))
      .toThrow('rulesGetAfterSiblingMergeSoloPrimary control answered "ALLOW", expected DENY');
  });

  it('refuses a capture whose full-update batch control denied', () => {
    expect(() => assertGetAfterProbeControls({ ...passing, rulesGetAfterSiblingMergeFullBatch: 'DENY' }))
      .toThrow('rulesGetAfterSiblingMergeFullBatch control answered "DENY", expected ALLOW');
  });

  it('refuses a capture with a missing control', () => {
    const { rulesGetAfterSiblingMergeFullBatch: _omitted, ...missing } = passing;
    expect(() => assertGetAfterProbeControls(missing)).toThrow('expected ALLOW');
  });
});
