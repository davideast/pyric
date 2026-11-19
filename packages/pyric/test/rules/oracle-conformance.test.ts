/**
 * The package-level oracle gate delegates to the same replay assertion used by
 * score and report computation. Keeping one implementation prevents the test
 * command and published trust number from disagreeing about replay semantics.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintFirestoreRules } from '@pyric/rules/internal';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { injectFirestoreProbeRules } from '../../../../packages/conformance/src/firestore-real-rules.ts';
import {
  siblingMergeProbePlan,
  type ProbeVerdict,
  type ProbeWrite,
} from '../../../../packages/conformance/src/firestore-real-sibling-merge.ts';
import { replayFirestoreRulesObservations } from '../../../../packages/conformance/src/firestore-rules-oracle-replay.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIBLING_MERGE_OBSERVATION_PATH = join(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'conformance',
  'observations',
  'firestore-rules',
  'rules-firestore-atomic-batch-sibling-merge.json',
);
const SIBLING_MERGE_CASE =
  'getAfter reflects merged pre-existing fields alongside batch updates ALLOW';

const replays = await replayFirestoreRulesObservations();

function decisionToVerdict(allowed: boolean): ProbeVerdict {
  if (allowed) {
    return 'ALLOW';
  }
  return 'DENY';
}

describe('oracle conformance (rules-firestore)', () => {
  for (const replay of replays) {
    it(`${replay.rowId}: ${replay.name}: replays the captured production verdict contract`, () => {
      expect(replay.problems).toEqual([]);
    });
  }

  it('every captured rules-firestore observation maps to one registry row', () => {
    expect(replays).toHaveLength(60);
    expect(replays.every(({ rowId }) => /^firestore-rules#\d+$/.test(rowId))).toBe(true);
  });
});

describe('oracle conformance (rules-firestore real-database sibling-merge replay)', () => {
  it('firestore-rules#190: replays rules-firestore-atomic-batch-sibling-merge.json controls and nested field-mask merge', () => {
    const captured = JSON.parse(readFileSync(SIBLING_MERGE_OBSERVATION_PATH, 'utf8')) as {
      behavior: Record<string, ProbeVerdict>;
      diagnostics: {
        productionDatabase: {
          siblingMergeBatch: ProbeVerdict;
          siblingMergeSoloPrimary: ProbeVerdict;
          siblingMergeFullBatch: ProbeVerdict;
        };
      };
    };

    const runId = 'oracle-conformance-replay';
    const auth = { uid: `pyric-browser-${runId}` };
    const baseRules = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n  }\n}\n`;
    const plan = siblingMergeProbePlan(runId);
    const probeEnv = new LocalEnvironment();
    probeEnv.seed({
      rules: injectFirestoreProbeRules(baseRules, runId),
      documents: plan.seed,
    });
    const runBatch = (writes: ProbeWrite[]): ProbeVerdict =>
      decisionToVerdict(probeEnv.batch(writes, auth).allowed);

    const soloVerdict = decisionToVerdict(
      probeEnv.execute({ ...plan.soloPrimary, auth }).allowed,
    );
    const batchVerdict = runBatch(plan.batch);
    const fullBatchVerdict = runBatch(plan.fullBatch);

    expect(soloVerdict).toBe(captured.diagnostics.productionDatabase.siblingMergeSoloPrimary);
    expect(batchVerdict).toBe(captured.diagnostics.productionDatabase.siblingMergeBatch);
    expect(batchVerdict).toBe(captured.behavior[SIBLING_MERGE_CASE]);
    expect(fullBatchVerdict).toBe(captured.diagnostics.productionDatabase.siblingMergeFullBatch);

    const nestedRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/a {
      allow create: if getAfter(/databases/$(database)/documents/docs/b).data.meta.role == 'admin'
                    && getAfter(/databases/$(database)/documents/docs/b).data.updated == true;
    }
    match /docs/b {
      allow update: if true;
    }
  }
}`;
    const nestedEnv = new LocalEnvironment();
    nestedEnv.seed({
      rules: nestedRules,
      documents: { 'docs/b': { meta: { role: 'admin', team: 'eng' }, version: 1 } },
    });
    const nestedResult = nestedEnv.batch(
      [
        { method: 'update', path: 'docs/b', data: { updated: true } },
        { method: 'create', path: 'docs/a', data: { status: 'checked' } },
      ],
      null,
    );
    expect(nestedResult.allowed).toBe(true);
    expect(nestedEnv.getDocument('docs/b')).toEqual({
      meta: { role: 'admin', team: 'eng' },
      version: 1,
      updated: true,
    });
  });

  it('firestore-rules#191: compile-time AST verification rejects non-conforming bool(), math.isInfinite(), and Map hasAll()', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{doc} {
      allow read: if bool('true') == true;
      allow write: if math.isInfinite(1.0);
      allow delete: if request.resource.data.hasAll(['field']);
    }
  }
}`;
    const res = lintFirestoreRules(source);
    const ruleNames = res.warnings.map((w) => w.rule);
    expect(ruleNames).toContain('HALLUCINATED_GLOBAL');
    expect(ruleNames).toContain('HALLUCINATED_METHOD');
  });
});
