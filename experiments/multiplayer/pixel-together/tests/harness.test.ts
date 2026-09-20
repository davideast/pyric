import { expect, test } from 'bun:test';
import { runExperiment, compareRuns } from '../scenarios/harness.mjs';

test('detects lost edits and compares repaired models under the same schedule', async () => {
  const run = await runExperiment();
  const invariant = (variant: string) => run.assertions.find((a: any) => a.caseId === variant && a.name === 'distinct edits survive');
  expect(invariant('stale-grid')?.passed).toBe(false);
  expect(invariant('transaction-grid')?.passed).toBe(true);
  expect(invariant('pixel-records')?.passed).toBe(true);
  expect(run.cases.every((c: any) => c.status === 'complete')).toBe(true);
  expect(run.assertions.filter((a: any) => a.caseId === 'claims').every((a: any) => a.passed)).toBe(true);
  expect(run.operations.every((o: any) => o.runId === run.run.id)).toBe(true);
  expect(run.run.environment.backend).toBe('pyric');
  expect(run.run.environment.production).toBe(false);
  expect(compareRuns(run, run).compatible).toBe(true);
  const changed = structuredClone(run);
  changed.run.workloadHash = 'different';
  expect(compareRuns(run, changed).compatible).toBe(false);
});

test('records a real transaction retry and two listener update deliveries per model', async () => {
  const run = await runExperiment();
  const reads = run.operations.filter((o: any) => o.caseId === 'transaction-grid' && o.actor === 'bob' && o.kind === 'transaction-read');
  expect(reads.length).toBe(2);
  expect(reads.map((o: any) => o.attempt)).toEqual([1, 2]);
  for (const variant of ['stale-grid', 'transaction-grid', 'pixel-records']) {
    const delivered = run.observations.filter((o: any) => o.caseId === variant && o.kind === 'listener-delivery' && o.value.marker === 'convergence');
    expect(new Set(delivered.map((o: any) => o.actor))).toEqual(new Set(['alice', 'bob']));
  }
});

test('missing cases and unexpected baseline success cannot give a green experiment', async () => {
  const { assessRun } = await import('../scenarios/harness.mjs');
  const run = await runExperiment();
  expect(assessRun(run).successfulExperiment).toBe(true);
  const missing = structuredClone(run); missing.assertions = [];
  expect(assessRun(missing).successfulExperiment).toBe(false);
  const changed = structuredClone(run);
  changed.assertions.find((a: any) => a.caseId === 'stale-grid' && a.name === 'distinct edits survive').passed = true;
  expect(assessRun(changed).successfulExperiment).toBe(false);
  expect(compareRuns(run, missing).compatible).toBe(false);
  expect(compareRuns(missing, missing).compatible).toBe(false);
  const disagreement = structuredClone(run); disagreement.assertions[0].passed = true;
  expect(compareRuns(run, disagreement).compatible).toBe(true);
  expect(compareRuns(run, disagreement).decisions[0]).toMatchObject({ left: false, right: true });
  const incomplete = structuredClone(run); incomplete.cases[0].status = 'error';
  expect(compareRuns(run, incomplete).compatible).toBe(false);
});

test('claim generations reject stale writes while same-pixel ordering and resubscription remain explicit', async () => {
  const { assessRun } = await import('../scenarios/harness.mjs');
  const run = await runExperiment();
  const check = (caseId: string, name: string) => run.assertions.find((a: any) => a.caseId === caseId && a.name === name);
  expect(check('claim-aba-control', 'old claim write rejected after reacquisition')?.passed).toBe(false);
  expect(check('fenced-claims', 'old claim write rejected after reacquisition')?.passed).toBe(true);
  expect(check('fenced-claims', 'stale release rejected')?.passed).toBe(true);
  expect(check('same-pixel', 'later serialized commit wins')?.actual).toBe('blue');
  expect(check('listener-resubscribe', 'resubscription observes missed write')?.actual).toBe('blue');
  expect(assessRun(run).successfulExperiment).toBe(true);
});

test('measures competing ownership, mid-transaction transfer, delayed release, and concurrent pixels', async () => {
  const run = await runExperiment();
  const check = (caseId: string, name: string) => run.assertions.find((a: any) => a.caseId === caseId && a.name === name);
  expect(check('competing-reacquisition', 'exactly one winner and one epoch increment')?.passed).toBe(true);
  expect(check('ownership-during-draw', 'old drawing does not commit')?.passed).toBe(true);
  expect(check('delayed-release', 'new ownership survives delayed release')?.passed).toBe(true);
  expect(check('multiple-colors', 'one user owns at most one color')?.passed).toBe(false);
  expect(check('concurrent-pixel', 'both listeners converge to saved winner')?.passed).toBe(true);
});

test('paired ownership enforces both cardinalities and atomic release/switch with stale-token rejection', async () => {
  const { assessRun } = await import('../scenarios/harness.mjs');
  const run = await runExperiment();
  const paired = run.assertions.filter((a: any) => a.caseId.startsWith('paired-'));
  expect(paired.length).toBeGreaterThanOrEqual(15);
  expect(paired.every((a: any) => a.passed)).toBe(true);
  expect(run.cases.filter((c: any) => c.id.startsWith('paired-')).every((c: any) => c.status === 'complete')).toBe(true);
  expect(assessRun(run).successfulExperiment).toBe(true);
});
