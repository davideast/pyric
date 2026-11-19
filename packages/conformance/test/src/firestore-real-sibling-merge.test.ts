/**
 * Runs the real-database sibling-merge probe (row firestore-rules#190) through
 * pyric's LocalEnvironment with the same rules, seed and writes, and compares
 * the verdicts directly against the committed production-database capture.
 *
 * The corpus case the Rules Test API replay pairs with this observation is a
 * single create with a `get` mock, so it passes whatever pyric's batch merge
 * does. This test fails whenever a batch update stops keeping the companion's
 * untouched fields in getAfter().
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
const SIBLING_MERGE_CASE =
  'getAfter reflects merged pre-existing fields alongside batch updates ALLOW';

const BASE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
  }
}
`;

const RUN_ID = 'local-replay';
const AUTH = { uid: `pyric-browser-${RUN_ID}` };

interface RecordedProductionDatabase {
  siblingMergeBatch: ProbeVerdict;
  siblingMergeSoloPrimary: ProbeVerdict;
  siblingMergeFullBatch: ProbeVerdict;
}

interface SiblingMergeObservationEnvelope {
  behavior?: Record<string, ProbeVerdict>;
  diagnostics?: {
    productionDatabase?: Partial<RecordedProductionDatabase>;
    hostedTestApiLimitation?: Record<string, unknown>;
  };
  lifecycle?: {
    restoredOriginalRelease?: boolean;
  };
}

function loadRecordedCapture(): {
  behaviorVerdict: ProbeVerdict;
  productionDatabase: RecordedProductionDatabase;
  restoredOriginalRelease: boolean;
  hasHostedLimitation: boolean;
} {
  const observation = JSON.parse(
    readFileSync(OBSERVATION_PATH, 'utf8'),
  ) as SiblingMergeObservationEnvelope;
  const behaviorVerdict = observation.behavior?.[SIBLING_MERGE_CASE];
  const prod = observation.diagnostics?.productionDatabase;
  if (
    !behaviorVerdict ||
    !prod?.siblingMergeBatch ||
    !prod.siblingMergeSoloPrimary ||
    !prod.siblingMergeFullBatch
  ) {
    throw new Error(
      'rules-firestore-atomic-batch-sibling-merge.json is missing required productionDatabase verdicts',
    );
  }
  const hasHostedLimitation = Boolean(
    observation.diagnostics?.hostedTestApiLimitation?.[SIBLING_MERGE_CASE],
  );
  const restoredOriginalRelease = observation.lifecycle?.restoredOriginalRelease === true;
  return {
    behaviorVerdict,
    productionDatabase: {
      siblingMergeBatch: prod.siblingMergeBatch,
      siblingMergeSoloPrimary: prod.siblingMergeSoloPrimary,
      siblingMergeFullBatch: prod.siblingMergeFullBatch,
    },
    restoredOriginalRelease,
    hasHostedLimitation,
  };
}

function toVerdict(allowed: boolean): ProbeVerdict {
  if (allowed) {
    return 'ALLOW';
  }
  return 'DENY';
}

function runLocally(): SiblingMergeVerdicts {
  const plan = siblingMergeProbePlan(RUN_ID);
  const env = new LocalEnvironment();
  env.seed({ rules: injectFirestoreProbeRules(BASE_RULES, RUN_ID), documents: plan.seed });
  const batch = (writes: ProbeWrite[]): ProbeVerdict =>
    toVerdict(env.batch(writes, AUTH).allowed);
  const soloPrimary = toVerdict(env.execute({ ...plan.soloPrimary, auth: AUTH }).allowed);
  return {
    soloPrimary,
    batch: batch(plan.batch),
    fullBatch: batch(plan.fullBatch),
  };
}

describe('firestore-rules#190 sibling-merge probe through LocalEnvironment', () => {
  const local = runLocally();
  const captured = loadRecordedCapture();

  it('matches the recorded production-database verdicts for the batch and the solo DENY control', () => {
    expect(captured.restoredOriginalRelease).toBe(true);
    expect(captured.hasHostedLimitation).toBe(true);
    expect(local.batch).toBe(captured.behaviorVerdict);
    expect({ soloPrimary: local.soloPrimary, batch: local.batch }).toEqual({
      soloPrimary: captured.productionDatabase.siblingMergeSoloPrimary,
      batch: captured.productionDatabase.siblingMergeBatch,
    });
  });

  it('matches the recorded production-database verdict for the two-field ALLOW batch control', () => {
    expect(local.fullBatch).toBe(captured.productionDatabase.siblingMergeFullBatch);
  });

  it('passes the capture writer control checks on both local and recorded production verdicts', () => {
    expect(() =>
      assertGetAfterProbeControls({
        rulesGetAfterSoloPrimary: 'DENY',
        rulesGetAfterSiblingMergeSoloPrimary: captured.productionDatabase.siblingMergeSoloPrimary,
        rulesGetAfterSiblingMergeFullBatch: captured.productionDatabase.siblingMergeFullBatch,
      }),
    ).not.toThrow();
    expect(() =>
      assertGetAfterProbeControls({
        rulesGetAfterSoloPrimary: 'DENY',
        rulesGetAfterSiblingMergeSoloPrimary: local.soloPrimary,
        rulesGetAfterSiblingMergeFullBatch: local.fullBatch,
      }),
    ).not.toThrow();
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
