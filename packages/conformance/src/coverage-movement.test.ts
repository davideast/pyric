import { describe, expect, it } from 'bun:test';
import {
  classifyMovements,
  movementProblems,
  releaseProblems,
  type Baseline,
  type CoverageReport,
  type EvidenceCensus,
  type Metric,
} from './coverage.ts';

/**
 * The accounting is pure: given a baseline and a run, it says WHY each number
 * moved. These fixtures are the shapes of the fakes it exists to refuse.
 */
const EVIDENCE: EvidenceCensus = {
  observations: 231,
  observationDigest: 'sha256:seal',
  verifiedScenarios: 45,
  conformanceChecks: 5,
  conformanceTests: 120,
  mappedExports: 400,
};

function baseline(
  metrics: Record<string, Metric>,
  evidence: EvidenceCensus = EVIDENCE,
  contamination: Record<string, Record<string, string[]>> = {},
): Baseline {
  return {
    generatedAt: 'then',
    services: {},
    overall: { surfaceCoveragePct: { total: 0, intended: 0 } },
    rowStatuses: {},
    highRiskUnverified: [],
    orphanObservations: [],
    entryPathVerdicts: {},
    metrics,
    evidence,
    rulesLanguageExclusions: {},
    rulesLanguageContamination: contamination,
  };
}

function report(
  metrics: Record<string, Metric>,
  evidence: EvidenceCensus = EVIDENCE,
  over: Partial<CoverageReport> = {},
): CoverageReport {
  return {
    generatedAt: 'now',
    services: [],
    overall: {} as CoverageReport['overall'],
    rulesLanguage: [],
    metrics,
    evidence,
    orphanObservations: [],
    highRiskUnverified: [],
    rowStatuses: {},
    entryPath: [],
    ...over,
  } as unknown as CoverageReport;
}

const attribution = (base: Baseline, run: CoverageReport, metric: string) =>
  classifyMovements(base, run).find((m) => m.metric === metric)?.attribution;

describe('number-movement accounting: the gate REFUSES a number that rose on nothing', () => {
  it('NEGATIVE — a coverage rise driven purely by a SHRUNK DENOMINATOR fails', () => {
    // The fake: 105/140 (75%) is inconvenient, so the 35 unverified constructs
    // are excluded from the denominator. 105/105 = 100%. Nothing was captured,
    // nothing was fixed, and the published number reads perfect.
    const base = baseline({ 'rules-language:firestore:verified': { numerator: 105, denominator: 140 } });
    const run = report({ 'rules-language:firestore:verified': { numerator: 105, denominator: 105 } });

    expect(attribution(base, run, 'rules-language:firestore:verified')).toBe('reclassification');
    const problems = movementProblems(classifyMovements(base, run));
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('denominator SHRANK by 35');
    expect(problems[0]).toContain('75% -> 100%');
  });

  it('NEGATIVE — a NUMERATOR that rose while the evidence census stood still fails', () => {
    // The fake: rows are relabelled `conforms`, or constructs are credited,
    // without a single new observation, scenario, check, test, or mirrored
    // export. Credit with nothing behind it.
    const base = baseline({ 'behavior:overall:intended': { numerator: 700, denominator: 800 } });
    const run = report({ 'behavior:overall:intended': { numerator: 760, denominator: 800 } });

    expect(attribution(base, run, 'behavior:overall:intended')).toBe('unbacked-credit');
    const problems = movementProblems(classifyMovements(base, run));
    expect(problems[0]).toContain('numerator ROSE by 60 while the evidence census did not move');
  });

  it('NEGATIVE — a deny-listed export (denominator shrink) cannot lift surface coverage', () => {
    const base = baseline({ 'surface:auth:intended': { numerator: 60, denominator: 160 } });
    const run = report({ 'surface:auth:intended': { numerator: 60, denominator: 100 } });
    expect(attribution(base, run, 'surface:auth:intended')).toBe('reclassification');
    expect(movementProblems(classifyMovements(base, run)).length).toBe(1);
  });

  it('POSITIVE — a numerator that rose on a NEW CAPTURE passes, and is named as such', () => {
    const base = baseline({ 'rules-language:rtdb:verified': { numerator: 52, denominator: 55 } });
    const run = report(
      { 'rules-language:rtdb:verified': { numerator: 55, denominator: 55 } },
      { ...EVIDENCE, observations: 234, verifiedScenarios: 48 },
    );
    const movement = classifyMovements(base, run)[0];
    expect(movement.attribution).toBe('new-evidence');
    expect(movement.detail).toContain('+3 observation(s)');
    expect(movement.detail).toContain('+3 captured scenario twin(s)');
    expect(movementProblems(classifyMovements(base, run))).toEqual([]);
  });

  it('POSITIVE — a numerator that rose on NEWLY MIRRORED EXPORTS passes', () => {
    const base = baseline({ 'surface:auth:intended': { numerator: 60, denominator: 160 } });
    const run = report(
      { 'surface:auth:intended': { numerator: 75, denominator: 160 } },
      { ...EVIDENCE, mappedExports: 415 },
    );
    expect(attribution(base, run, 'surface:auth:intended')).toBe('new-evidence');
    expect(movementProblems(classifyMovements(base, run))).toEqual([]);
  });

  it('POSITIVE — a RE-CAPTURE (same count, changed behavior seals) counts as new evidence', () => {
    const base = baseline({ 'behavior:overall:intended': { numerator: 700, denominator: 800 } });
    const run = report(
      { 'behavior:overall:intended': { numerator: 701, denominator: 800 } },
      { ...EVIDENCE, observationDigest: 'sha256:different' },
    );
    const movement = classifyMovements(base, run)[0];
    expect(movement.attribution).toBe('new-evidence');
    expect(movement.detail).toContain('re-captured observation(s)');
  });

  it('a number that FELL is a regression, not a reclassification (the ratchet owns it)', () => {
    // Defense #1 lowers rules-language verified coverage with no new evidence.
    // That is a regression the ratchet reports and --update-baseline accepts; it
    // is never silently allowed, and it is never mistaken for a fake.
    const base = baseline({ 'rules-language:firestore:verified': { numerator: 128, denominator: 140 } });
    const run = report({ 'rules-language:firestore:verified': { numerator: 105, denominator: 140 } });
    expect(attribution(base, run, 'rules-language:firestore:verified')).toBe('regression');
    expect(movementProblems(classifyMovements(base, run))).toEqual([]);
  });

  it('a denominator that GREW while the ratio held is not a fake (new surface admitted)', () => {
    const base = baseline({ 'surface:overall:total': { numerator: 400, denominator: 800 } });
    const run = report(
      { 'surface:overall:total': { numerator: 410, denominator: 820 } },
      { ...EVIDENCE, mappedExports: 410 },
    );
    expect(movementProblems(classifyMovements(base, run))).toEqual([]);
  });

  it('an untouched metric reports `unchanged` and raises nothing', () => {
    const base = baseline({ 'surface:overall:total': { numerator: 400, denominator: 800 } });
    const run = report({ 'surface:overall:total': { numerator: 400, denominator: 800 } });
    expect(attribution(base, run, 'surface:overall:total')).toBe('unchanged');
    expect(movementProblems(classifyMovements(base, run))).toEqual([]);
  });
});


describe('contamination release: the gate REFUSES credit reclaimed by narrowing a divergence', () => {
  /** At baseline, two constructs are held out of the verified count by one
   *  `diverged-documented` rules-engine row. */
  const heldBy161 = {
    firestore: {
      'firestore.function.hashing.md5': ['firestore-rules#161'],
      'firestore.method.bytes.toBase64': ['firestore-rules#161'],
    },
  };

  it('NEGATIVE — deleting a construct from a STILL-DIVERGED row\'s scope fails, naming the construct and the row', () => {
    // The cheapest fake in the chain: the engine is still wrong about md5, the
    // row still says so, but the construct is quietly removed from that row's
    // `constructs` scope and silently regains credit.
    const base = baseline({}, EVIDENCE, heldBy161);
    const run = report({}, EVIDENCE, {
      rulesLanguage: [{ engine: 'firestore', contaminatedBy: {} }],
      rowStatuses: { 'firestore-rules#161': 'diverged-documented' },
    } as unknown as Partial<CoverageReport>);

    const problems = releaseProblems(base, run);
    expect(problems.length).toBe(2);
    expect(problems[0]).toContain('firestore.function.hashing.md5');
    expect(problems[0]).toContain("firestore-rules#161 is STILL 'diverged-documented'");
    expect(problems[0]).toContain('Fix the engine; do not un-annotate it');
  });

  it('NEGATIVE — it fires even when unrelated evidence lands in the same PR', () => {
    // The evidence census cannot catch this one: any unrelated capture moves the
    // census and would excuse the numerator's rise. The release rule is what
    // closes that, and it does not consult the census at all.
    const base = baseline({}, EVIDENCE, heldBy161);
    const run = report(
      {},
      { ...EVIDENCE, observations: 999, observationDigest: 'sha256:brand-new' },
      {
        rulesLanguage: [{ engine: 'firestore', contaminatedBy: {} }],
        rowStatuses: { 'firestore-rules#161': 'diverged-documented' },
      } as unknown as Partial<CoverageReport>,
    );
    expect(releaseProblems(base, run).length).toBe(2);
  });

  it('POSITIVE — a construct released because the ENGINE WAS FIXED (row now `conforms`) is allowed', () => {
    const base = baseline({}, EVIDENCE, heldBy161);
    const run = report({}, EVIDENCE, {
      rulesLanguage: [{ engine: 'firestore', contaminatedBy: {} }],
      rowStatuses: { 'firestore-rules#161': 'conforms' },
    } as unknown as Partial<CoverageReport>);
    expect(releaseProblems(base, run)).toEqual([]);
  });

  it('POSITIVE — a construct still held by its divergence raises nothing', () => {
    const base = baseline({}, EVIDENCE, heldBy161);
    const run = report({}, EVIDENCE, {
      rulesLanguage: [{ engine: 'firestore', contaminatedBy: heldBy161.firestore }],
      rowStatuses: { 'firestore-rules#161': 'diverged-documented' },
    } as unknown as Partial<CoverageReport>);
    expect(releaseProblems(base, run)).toEqual([]);
  });
});
