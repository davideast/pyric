import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MAX_BATCH,
  QUEUE_LABEL,
  decideQueueStep,
  dequeueComment,
  formatStagingTrailers,
  landedComment,
  maxSearchRuns,
  parseStagedPulls,
  parseStagingCommit,
  type ActiveStaging,
  type CheckState,
  type DequeueAction,
  type LandAction,
  type QueueAction,
  type QueueFacts,
  type QueuedPull,
  type StagedMeta,
  type StagingRun,
} from './merge-queue.ts';
import { MAX_TRANSITIONS, World } from './merge-queue-model.ts';

const MAIN = '1'.repeat(40);
const STAGED = 'c'.repeat(40);
const NOW = Date.parse('2026-11-14T12:00:00Z');
const RUN_URL = 'https://github.com/owner/repo/actions/runs/500';

function sha(seed: number): string {
  return seed.toString(16).padStart(2, '0').repeat(20);
}

function pull(number: number, overrides: Partial<QueuedPull> = {}): QueuedPull {
  return {
    number,
    title: `fix(rules): change ${number}`,
    isDraft: false,
    headRef: `fix/change-${number}`,
    headSha: sha(number),
    headRepoFullName: 'owner/repo',
    labels: [QUEUE_LABEL],
    labeledAt: `2026-11-14T11:${String(number % 60).padStart(2, '0')}:00Z`,
    prRequiredState: 'success',
    ...overrides,
  };
}

function stagingRun(overrides: Partial<StagingRun> = {}): StagingRun {
  return {
    id: 500, attempt: 1, totalRunsForCommit: 1, status: 'completed', conclusion: 'success',
    requiredCheckState: 'success', requiredCheckConclusion: 'success', url: RUN_URL, failedJobs: [],
    ...overrides,
  };
}

function metaFor(pulls: readonly QueuedPull[], extra: Partial<StagedMeta> = {}): StagedMeta {
  return { baseSha: MAIN, pulls: pulls.map((item) => ({ number: item.number, headSha: item.headSha })), ...extra };
}

function facts(candidates: readonly QueuedPull[], overrides: Partial<QueueFacts> = {}): QueueFacts {
  return { repo: 'owner/repo', mainSha: MAIN, candidates, nowMs: NOW, ...overrides };
}

function staged(candidates: readonly QueuedPull[], batch: readonly QueuedPull[], run: StagingRun | undefined, extra: Partial<StagedMeta> = {}): QueueFacts {
  const activeStaging: ActiveStaging = { stagingSha: STAGED, committedAtMs: NOW - 120_000, meta: metaFor(batch, extra) };
  if (run !== undefined) activeStaging.buildRun = run;
  return facts(candidates, { activeStaging });
}

function numbers(action: QueueAction): number[] {
  if ('pulls' in action) return action.pulls.map((item) => item.number);
  return [];
}

/** A seeded generator, so a failing sequence can be replayed from its seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('staging commit metadata', () => {
  test('round-trips the base, the batch, and a culprit search through the trailer block', () => {
    const plain: StagedMeta = { baseSha: MAIN, pulls: [{ number: 101, headSha: sha(1) }, { number: 102, headSha: sha(2) }] };
    const searching: StagedMeta = { ...plain, pulls: [plain.pulls[0]!], search: { suspects: plain.pulls, failedRunUrl: RUN_URL } };
    expect(parseStagingCommit(`Merge queue batch: #101, #102\n\n- #101 a title\n\n${formatStagingTrailers(plain)}\n`)).toEqual(plain);
    expect(parseStagingCommit(`Merge pull request #101 from fix/a\n\na title\n\n${formatStagingTrailers(searching)}`)).toEqual(searching);
    expect(parseStagedPulls(`Merge pull request #101 from fix/a\n\na title\n\nMerge-Queue-Pull: #101 ${sha(1)}`)).toEqual([{ number: 101, headSha: sha(1) }]);
  });

  test('reads trailers only from the last paragraph, so a pull request title cannot forge them', () => {
    const forged = `Merge pull request #7 from fix/a\n\nMerge-Queue-Base: ${MAIN}\n\nMerge-Queue-Pull: #7 ${sha(7)}`;
    expect(parseStagingCommit(forged)).toBeUndefined();
    expect(parseStagingCommit('Merge pull request #101 from owner/fix')).toBeUndefined();
  });
});

describe('merge queue decisions', () => {
  test('stages every ready pull request in one batch, first-in first-out, up to the cap', () => {
    const queue = [pull(3), pull(1), pull(2, { prRequiredState: 'pending' }), pull(4, { isDraft: true })];
    const action = decideQueueStep(facts(queue));
    expect(action.kind).toBe('stage');
    expect(numbers(action)).toEqual([1, 3]);

    const many = Array.from({ length: MAX_BATCH + 3 }, (_, index) => pull(index + 1));
    expect(numbers(decideQueueStep(facts(many)))).toEqual(many.slice(0, MAX_BATCH).map((item) => item.number));
  });

  test('a batch that holds a revert holds only reverts, and a ready revert preempts a staged normal batch', () => {
    const normal = pull(1);
    const revert = pull(9, { title: 'revert: fix(cli): broken flag' });
    const ownBranch = pull(8, { headRef: `auto-revert/${MAIN}` });
    expect(numbers(decideQueueStep(facts([normal, revert, ownBranch])))).toEqual([8, 9]);

    const inFlight = stagingRun({ id: 601, status: 'in_progress', conclusion: null });
    const preempt = decideQueueStep(staged([normal, revert], [normal], inFlight));
    expect(preempt).toMatchObject({ kind: 'stage', cancelRunId: 601 });
    expect(numbers(preempt)).toEqual([9]);
  });

  test('a later arrival does not restart a staged batch, and a changed member or a moved main does', () => {
    const first = pull(1);
    const second = pull(2);
    const late = pull(0);
    const inFlight = stagingRun({ status: 'in_progress', conclusion: null });
    expect(decideQueueStep(staged([first, second, late], [first, second], inFlight))).toMatchObject({ kind: 'wait-staging', stagingSha: STAGED });

    const moved = { ...second, headSha: sha(77) };
    expect(numbers(decideQueueStep(staged([first, moved], [first, second], inFlight)))).toEqual([1, 2]);
    expect(decideQueueStep(staged([first, moved], [first, second], inFlight))).toMatchObject({ kind: 'stage', cancelRunId: 500 });
    const mainMoved = decideQueueStep({ ...staged([first, second], [first, second], inFlight), mainSha: sha(99) });
    expect(mainMoved).toMatchObject({ kind: 'stage', baseSha: sha(99) });
  });

  test('lands the whole batch on a green run and required check, and waits while the check settles', () => {
    const batch = [pull(1), pull(2), pull(3, { labels: [QUEUE_LABEL, 'ci-packaging'] })];
    expect(decideQueueStep(staged(batch, batch, stagingRun()))).toEqual({
      kind: 'land', pulls: batch, baseSha: MAIN, stagingSha: STAGED, runUrl: RUN_URL, refusedBefore: false,
    });
    expect(decideQueueStep({ ...staged(batch, batch, stagingRun()), refusedStagingSha: STAGED })).toMatchObject({ kind: 'land', refusedBefore: true });
    const settling = stagingRun({ requiredCheckState: 'pending', requiredCheckConclusion: null });
    expect(decideQueueStep(staged(batch, batch, settling)).kind).toBe('wait-staging');
    expect(decideQueueStep(facts(batch))).toMatchObject({ kind: 'stage', releaseProof: true });
  });

  test('waits out the registration window, redispatches a cancelled run once, then removes the batch', () => {
    const batch = [pull(1), pull(2)];
    const fresh = staged(batch, batch, undefined);
    expect(decideQueueStep({ ...fresh, nowMs: NOW - 100_000 }).kind).toBe('wait-staging');
    expect(decideQueueStep(fresh).kind).toBe('dispatch-staging');
    expect(decideQueueStep(staged(batch, batch, stagingRun({ conclusion: 'cancelled' }))).kind).toBe('dispatch-staging');
    const twice = decideQueueStep(staged(batch, batch, stagingRun({ conclusion: 'cancelled', totalRunsForCommit: 2 })));
    expect(twice).toMatchObject({ kind: 'dequeue', reason: 'staging-cancelled', cleanStaging: true });
    expect(numbers(twice)).toEqual([1, 2]);
  });

  test('reruns a failed batch once, then splits it instead of removing it', () => {
    const batch = [pull(1), pull(2), pull(3), pull(4), pull(5)];
    const failedOnce = stagingRun({ id: 501, conclusion: 'failure', requiredCheckState: 'failure', requiredCheckConclusion: 'failure' });
    expect(decideQueueStep(staged(batch, batch, failedOnce))).toMatchObject({ kind: 'rerun-staging', runId: 501 });

    const failedTwice = { ...failedOnce, attempt: 2 };
    const probe = decideQueueStep(staged(batch, batch, failedTwice));
    expect(probe).toMatchObject({ kind: 'stage', baseSha: MAIN, search: { suspects: metaFor(batch).pulls, failedRunUrl: RUN_URL } });
    expect(numbers(probe)).toEqual([1, 2]);

    const checkFailed = stagingRun({ requiredCheckState: 'failure', requiredCheckConclusion: 'failure' });
    expect(numbers(decideQueueStep(staged(batch, batch, checkFailed)))).toEqual([1, 2]);
  });

  test('a probe that fails twice narrows the suspects to itself, and a lone suspect is removed with the run that failed', () => {
    const batch = [pull(1), pull(2), pull(3), pull(4)];
    const search = { suspects: metaFor(batch).pulls, failedRunUrl: RUN_URL };
    const failedTwice = stagingRun({ id: 502, attempt: 2, conclusion: 'failure', requiredCheckState: 'failure', requiredCheckConclusion: 'failure', url: 'https://github.com/owner/repo/actions/runs/502', failedJobs: ['Packaging gate'] });
    const narrowed = decideQueueStep(staged(batch, batch.slice(0, 2), failedTwice, { search }));
    expect(narrowed).toMatchObject({ kind: 'stage', search: { suspects: metaFor(batch.slice(0, 2)).pulls } });
    expect(numbers(narrowed)).toEqual([1]);

    const lone = decideQueueStep(staged(batch, [batch[0]!], failedTwice, { search: { ...search, suspects: metaFor(batch.slice(0, 2)).pulls } }));
    expect(lone).toEqual({
      kind: 'dequeue', pulls: [batch[0]!], reason: 'staging-checks-failed', runUrl: 'https://github.com/owner/repo/actions/runs/502',
      failedJobs: ['Packaging gate'], bySearch: true, cleanStaging: true,
    });
  });

  test('a probe that passes lands, and the suspects left behind are searched from the landed commit', () => {
    const batch = [pull(1), pull(2), pull(3), pull(4)];
    const search = { suspects: metaFor(batch).pulls, failedRunUrl: RUN_URL };
    const landing = decideQueueStep(staged(batch, batch.slice(0, 2), stagingRun(), { search }));
    expect(landing).toMatchObject({ kind: 'land', search });
    expect(numbers(landing)).toEqual([1, 2]);

    const rest = batch.slice(2);
    const landedState: QueueFacts = facts(rest, { mainSha: STAGED, activeStaging: { stagingSha: STAGED, committedAtMs: NOW, meta: metaFor(batch.slice(0, 2), { search }), buildRun: stagingRun() } });
    const next = decideQueueStep(landedState);
    expect(next).toMatchObject({ kind: 'stage', baseSha: STAGED, search: { suspects: metaFor(rest).pulls, failedRunUrl: RUN_URL } });
    expect(numbers(next)).toEqual([3]);

    const searchWithJobs = { ...search, suspects: metaFor(rest).pulls, failedJobs: ['Packaging gate'] };
    const oneLeft = facts([batch[3]!], { mainSha: STAGED, activeStaging: { stagingSha: STAGED, committedAtMs: NOW, meta: metaFor([batch[2]!], { search: searchWithJobs }) } });
    expect(decideQueueStep(oneLeft)).toEqual({
      kind: 'dequeue', pulls: [batch[3]!], reason: 'staging-checks-failed', runUrl: RUN_URL, failedJobs: ['Packaging gate'], bySearch: true, cleanStaging: true,
    });

    const changed = facts([{ ...batch[3]!, headSha: sha(66) }], { mainSha: STAGED, activeStaging: { stagingSha: STAGED, committedAtMs: NOW, meta: metaFor([batch[2]!], { search: { ...search, suspects: metaFor(rest).pulls } }) } });
    expect(decideQueueStep(changed).kind).toBe('clean-staging');
    expect(decideQueueStep(facts([pull(9)], { mainSha: STAGED, activeStaging: { stagingSha: STAGED, committedAtMs: NOW, meta: metaFor(batch) } }))).toEqual({ kind: 'clean-staging', reason: 'the staged batch landed' });
  });

  test('a single failing pull request is removed after one rerun, as before batching', () => {
    const only = pull(1);
    const failedTwice = stagingRun({ attempt: 2, conclusion: 'failure', requiredCheckState: 'failure', requiredCheckConclusion: 'failure', failedJobs: ['Packaging gate'] });
    const removed = decideQueueStep(staged([only], [only], failedTwice)) as DequeueAction;
    expect(removed).toEqual({ kind: 'dequeue', pulls: [only], reason: 'staging-checks-failed', runUrl: RUN_URL, failedJobs: ['Packaging gate'], cleanStaging: true });
    const comment = dequeueComment(removed, only, MAIN);
    expect(comment).toContain('Packaging gate');
    expect(comment).toContain('actions/runs/500');
    expect(comment).not.toContain('splitting');
    expect(dequeueComment({ ...removed, bySearch: true }, only, MAIN)).toContain('splitting a failed batch');
  });

  test('while main is red nothing normal is staged, landed, or blamed, and a revert still goes through', () => {
    const batch = [pull(1), pull(2)];
    const mainRed = { workflow: 'Slow app scenarios', runUrl: 'https://github.com/owner/repo/actions/runs/9' };
    expect(decideQueueStep(facts(batch, { mainRed }))).toEqual({ kind: 'hold-main-red', ...mainRed });
    const failedTwice = stagingRun({ attempt: 2, conclusion: 'failure', requiredCheckState: 'failure', requiredCheckConclusion: 'failure' });
    const inFlight = stagingRun({ id: 7, status: 'in_progress', conclusion: null });
    for (const run of [stagingRun(), failedTwice, inFlight]) {
      expect(decideQueueStep({ ...staged(batch, batch, run), mainRed })).toEqual({ kind: 'hold-main-red', ...mainRed });
    }

    const revert = pull(9, { title: 'revert: fix(cli): broken flag' });
    expect(numbers(decideQueueStep(facts([...batch, revert], { mainRed })))).toEqual([9]);
    expect(decideQueueStep({ ...staged([...batch, revert], batch, inFlight), mainRed })).toMatchObject({ kind: 'stage', pulls: [revert], cancelRunId: 7 });
    expect(decideQueueStep({ ...staged([...batch, revert], [revert], stagingRun()), mainRed })).toMatchObject({ kind: 'land', pulls: [revert] });
  });

  test('a revert batch that fails twice on a red main is kept and nobody is removed until the reverts or main change', () => {
    const mainRed = { workflow: 'Build & Test', runUrl: 'https://github.com/owner/repo/actions/runs/9' };
    const first = pull(8, { title: 'revert: one' });
    const second = pull(9, { title: 'revert: two' });
    const failedOnce = stagingRun({ conclusion: 'failure', requiredCheckState: 'failure', requiredCheckConclusion: 'failure' });
    const failedTwice = { ...failedOnce, attempt: 2 };
    expect(decideQueueStep({ ...staged([first, second], [first, second], failedOnce), mainRed }).kind).toBe('rerun-staging');
    expect(decideQueueStep({ ...staged([first, second], [first, second], failedTwice), mainRed })).toEqual({ kind: 'hold-main-red', ...mainRed });
    // Stacked reverts reordered ancestor-first on staging still match the same ready revert set.
    expect(decideQueueStep({ ...staged([first, second], [second, first], failedTwice), mainRed })).toEqual({ kind: 'hold-main-red', ...mainRed });
    expect(decideQueueStep({ ...staged([first], [first], failedTwice), mainRed })).toEqual({ kind: 'hold-main-red', ...mainRed });
    const third = pull(10, { title: 'revert: three' });
    expect(numbers(decideQueueStep({ ...staged([first, second, third], [first, second], failedTwice), mainRed }))).toEqual([8, 9, 10]);
    // The same failed batch on a main that is green again is searched as usual.
    expect(numbers(decideQueueStep(staged([first, second], [first, second], failedTwice)))).toEqual([8]);
  });

  test('removes fork and red pull requests at once, and cleans staging only when they are part of it', () => {
    const fork = pull(4, { headRepoFullName: 'stranger/repo' });
    const red = pull(5, { prRequiredState: 'failure' });
    expect(decideQueueStep(facts([fork]))).toEqual({ kind: 'dequeue', pulls: [fork], reason: 'cross-repository-pull-request', cleanStaging: false });
    const other = pull(1);
    expect(decideQueueStep(staged([other, red], [other], stagingRun()))).toMatchObject({ kind: 'dequeue', reason: 'pull-request-checks-failed', cleanStaging: false });
    const suspected = { search: { suspects: metaFor([other, { ...red, prRequiredState: 'success' }]).pulls, failedRunUrl: RUN_URL } };
    expect(decideQueueStep(staged([other, red], [other], stagingRun(), suspected))).toMatchObject({ kind: 'dequeue', cleanStaging: true });
  });

  test('idles when empty, waits on pending checks, and cleans a staging branch nobody is waiting on', () => {
    expect(decideQueueStep(facts([]))).toEqual({ kind: 'idle', reason: 'queue is empty' });
    const pending = pull(1, { prRequiredState: 'pending' });
    expect(decideQueueStep(facts([pending]))).toEqual({ kind: 'wait-pr-checks', pull: pending });
    const orphan = staged([], [pull(9)], stagingRun({ status: 'in_progress', conclusion: null }));
    expect(decideQueueStep(orphan)).toEqual({ kind: 'clean-staging', reason: 'no ready pull requests remain', cancelRunId: 500 });
  });

  test('the landed comment names the commit, the staging run, and the rest of the batch', () => {
    const batch = [pull(1), pull(2)];
    const land = decideQueueStep(staged(batch, batch, stagingRun())) as LandAction;
    const comment = landedComment(land, batch[0]!);
    expect(comment).toContain(STAGED);
    expect(comment).toContain(RUN_URL);
    expect(comment).toContain('#2');
    expect(comment).not.toContain('\u2014');
  });
});

describe('queue model: batching', () => {
  test.each([1, 2, 3, 5, MAX_BATCH])('%i ready pull requests cost one staging run and land in queue order', (count) => {
    const world = new World();
    for (let index = 0; index < count; index++) world.addPull();
    expect(world.drain()).toBe(true);
    expect(world.stats.attempts).toBe(1);
    expect(world.stats.landings.map((landing) => landing.pulls)).toEqual([Array.from({ length: count }, (_, index) => 101 + index)]);
    expect(world.candidates()).toEqual([]);
  });

  test('more ready pull requests than the cap cost one run per full batch', () => {
    const world = new World();
    for (let index = 0; index < 2 * MAX_BATCH + 3; index++) world.addPull();
    expect(world.drain()).toBe(true);
    expect(world.stats.attempts).toBe(3);
    expect(world.stats.landings.map((landing) => landing.pulls.length)).toEqual([MAX_BATCH, MAX_BATCH, 3]);
  });

  test('a single flaked attempt costs one rerun and removes nobody', () => {
    const world = new World();
    for (let index = 0; index < 4; index++) world.addPull();
    world.pass();
    world.completeRun(true);
    expect(world.drain()).toBe(true);
    expect(world.stats.attempts).toBe(2);
    expect(world.stats.dequeued).toEqual([]);
    expect(world.stats.landings[0]?.pulls).toEqual([101, 102, 103, 104]);
  });

  test('a conflicting pull request is removed while the batch is built and the rest land in the same run', () => {
    const world = new World();
    world.addPull();
    world.addPull({ conflicts: true });
    world.addPull();
    expect(world.drain()).toBe(true);
    expect(world.stats.attempts).toBe(1);
    expect(world.stats.dequeued).toEqual([{ number: 102, reason: 'merge-conflict' }]);
    expect(world.stats.landings[0]?.pulls).toEqual([101, 103]);
  });

  test('pull requests that arrive during a run wait for it and then land together in the next one', () => {
    const world = new World();
    world.addPull();
    world.pass();
    for (let index = 0; index < 4; index++) world.addPull();
    world.pass();
    expect(world.drain()).toBe(true);
    expect(world.stats.attempts).toBe(2);
    expect(world.stats.landings.map((landing) => landing.pulls)).toEqual([[101], [102, 103, 104, 105]]);
  });
});

describe('queue model: culprit search', () => {
  test('every placement of one failing pull request in a full batch removes only it, within the run bound, and lands the rest', () => {
    for (let size = 2; size <= MAX_BATCH; size++) {
      for (let culprit = 0; culprit < size; culprit++) {
        const world = new World();
        for (let index = 0; index < size; index++) world.addPull({ bad: index === culprit });
        expect(world.drain()).toBe(true);
        expect(world.stats.dequeued).toEqual([{ number: 101 + culprit, reason: 'staging-checks-failed' }]);
        const landed = world.stats.landings.flatMap((landing) => landing.pulls);
        expect(landed.sort((left, right) => left - right)).toEqual(Array.from({ length: size }, (_, index) => 101 + index).filter((number) => number !== 101 + culprit));
        expect(world.stats.searches).toHaveLength(1);
        const [used, allowed] = world.stats.searches[0]!;
        expect(allowed).toBe(maxSearchRuns(size));
        expect(used).toBeLessThanOrEqual(allowed);
        // The failed batch and its rerun, the search, and at most one run for what the search left queued.
        expect(world.stats.attempts).toBeLessThanOrEqual(2 + allowed + 1);
      }
    }
    expect(maxSearchRuns(MAX_BATCH)).toBe(6);
  });

  test('every subset of failing pull requests in a batch of five is removed exactly, and everything else lands', () => {
    for (let mask = 0; mask < 32; mask++) {
      const world = new World();
      const bad: number[] = [];
      for (let index = 0; index < 5; index++) {
        const isBad = (mask & (1 << index)) !== 0;
        if (isBad) bad.push(101 + index);
        world.addPull({ bad: isBad });
      }
      expect(world.drain()).toBe(true);
      expect(world.stats.dequeued.map((entry) => entry.number).sort()).toEqual(bad);
      expect(world.stats.landings.flatMap((landing) => landing.pulls)).toHaveLength(5 - bad.length);
      for (const [used, allowed] of world.stats.searches) expect(used).toBeLessThanOrEqual(allowed);
    }
  });
});

describe('queue model: red main', () => {
  test('holds normal pull requests while main is red, blames none of them, and lands the revert first', () => {
    const world = new World();
    world.addPull();
    world.addPull();
    world.pass();
    const broke = world.breakMain();
    world.completeRun();
    expect(world.drain()).toBe(true);
    expect(world.stats.landings).toEqual([]);
    expect(world.stats.dequeued).toEqual([]);
    expect(world.pass().at(-1)?.kind).toBe('hold-main-red');

    const revert = world.addPull({ revert: true, fixes: broke });
    expect(world.drain()).toBe(true);
    expect(world.stats.landings.map((landing) => landing.pulls)).toEqual([[revert.number], [101, 102]]);
    expect(world.stats.dequeued).toEqual([]);
  });
});

describe('queue model: arbitrary event sequences', () => {
  function randomWalk(seed: number, steps: number): World {
    const random = mulberry32(seed);
    const world = new World();
    const pick = (): number => 101 + Math.floor(random() * Math.max(world.pulls.size, 1));
    const breaks: number[] = [];
    const events: Array<[number, () => void]> = [
      [14, () => {
        const checks: CheckState = random() < 0.7 ? 'success' : 'pending';
        world.addPull({ bad: random() < 0.2, conflicts: random() < 0.08, checks, draft: random() < 0.05 });
      }],
      [4, () => world.addPull({ revert: true, bad: random() < 0.1 })],
      [22, () => world.completeRun(random() < 0.15)],
      [4, () => world.cancelRun()],
      [5, () => world.unlabel(pick())],
      [5, () => world.relabel(pick())],
      [5, () => world.pushHead(pick())],
      [10, () => {
        const outcome = random() < 0.85 ? 'success' : 'failure';
        world.settleChecks(pick(), outcome);
      }],
      [2, () => world.setDraft(pick(), random() < 0.5)],
      [3, () => world.moveMain()],
      [3, () => { if (!world.mainIsRed()) breaks.push(world.breakMain()); }],
      [3, () => { const broke = breaks.shift(); if (broke !== undefined) world.addPull({ revert: true, fixes: broke }); }],
      [8, () => {
        const delta = random() < 0.5 ? 20_000 : 90_000;
        world.tick(delta);
      }],
    ];
    const total = events.reduce((sum, [weight]) => sum + weight, 0);
    for (let step = 0; step < steps; step++) {
      let roll = random() * total;
      const event = events.find(([weight]) => (roll -= weight) < 0) ?? events[0]!;
      event[1]();
      const taken = world.pass();
      if (taken.length > MAX_TRANSITIONS) throw new Error('a pass took more steps than the transition cap');
    }
    // Let the queue come to rest: no more outside events, every break gets its revert, every check settles.
    // A red main is the one state the queue does not leave by itself when the ready reverts do not
    // repair it: a person takes the reverts that are not repairs out of the queue and puts every repair in.
    for (const broke of breaks) world.addPull({ revert: true, fixes: broke });
    for (const item of world.pulls.values()) {
      if (item.revert && item.fixes === undefined && world.mainIsRed()) world.unlabel(item.number);
      if (item.fixes !== undefined) {
        world.pushHead(item.number);
        world.relabel(item.number);
      }
      world.setDraft(item.number, false);
      world.settleChecks(item.number, 'success');
    }
    if (!world.drain(400)) throw new Error('the queue did not come to rest');
    return world;
  }

  test('300 seeded sequences keep every invariant and leave nothing ready in the queue', () => {
    let landedTogether = 0;
    let searches = 0;
    for (let seed = 1; seed <= 300; seed++) {
      let world: World;
      try {
        world = randomWalk(seed, 120);
      } catch (error) {
        let detail: string;
        if (error instanceof Error) detail = error.message;
        else detail = String(error);
        throw new Error(`seed ${seed}: ${detail}`);
      }
      // No starvation: at rest nothing is left labeled, and main holds nothing that fails.
      const atRest = { seed, queued: world.candidates().map((item) => item.number), mainRed: world.mainIsRed() };
      expect(atRest).toEqual({ seed, queued: [], mainRed: false });
      landedTogether += world.stats.landings.filter((landing) => landing.pulls.length > 1).length;
      searches += world.stats.searches.length;
    }
    // The sequences exercise what they claim to: batches of several pull requests and culprit searches.
    expect(landedTogether).toBeGreaterThan(100);
    expect(searches).toBeGreaterThan(50);
  });
});

describe('the merge queue workflow contract', () => {
  const workflowDir = resolve(import.meta.dir, '../../.github/workflows');
  const lane = () => Bun.YAML.parse(readFileSync(resolve(workflowDir, 'merge-queue.yml'), 'utf8')) as {
    name: string;
    on: Record<string, Record<string, unknown> | null>;
    concurrency: { group: string; 'cancel-in-progress': boolean };
    permissions: Record<string, string>;
    jobs: Record<string, {
      if?: string;
      permissions?: Record<string, string>;
      steps: Array<{ run?: string; env?: Record<string, string> }>;
    }>;
  };

  test('serializes runs without cancelling an active landing, guards fork pull requests, and defaults dispatch to dry-run', () => {
    const parsed = lane();
    expect(parsed.concurrency).toEqual({ group: 'merge-queue', 'cancel-in-progress': false });
    expect(parsed.permissions).toEqual({ contents: 'read' });
    expect(parsed.jobs.queue?.permissions).toEqual({
      actions: 'write',
      contents: 'write',
      issues: 'write',
      'pull-requests': 'write',
    });
    expect(parsed.jobs.queue?.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(parsed.jobs.queue?.if).toContain('github.event.workflow_run.head_repository.full_name == github.repository');
    const inputs = parsed.on.workflow_dispatch?.inputs as Record<string, { default?: unknown }>;
    expect(inputs.dry_run?.default).toBe(true);
    const runStep = parsed.jobs.queue?.steps.find((step) => step.run === 'bun scripts/ci/merge-queue-github.ts');
    expect(runStep).toBeDefined();
  });

  test('wakes when a watched main workflow finishes, so a held queue resumes once main is green again', () => {
    const watched = lane().on.workflow_run?.workflows as string[];
    expect(watched).toContain('Build & Test');
    expect(watched).toContain('Slow app scenarios');
  });
});
