// A small world the merge queue engine is run against in tests: pull
// requests, `main`, the staging branch and its run, and the events that
// change them. `pass` asks `decideQueueStep` for steps and carries them out
// the way `merge-queue-github.ts` does, and throws `Violation` the moment a
// step breaks a queue invariant. `merge-queue.test.ts` drives it with fixed
// and seeded random event sequences.

import {
  MAX_BATCH,
  QUEUE_LABEL,
  decideQueueStep,
  isFastlaneRevert,
  maxSearchRuns,
  type ActiveStaging,
  type CheckState,
  type DequeueReason,
  type QueueAction,
  type QueueFacts,
  type QueuedPull,
  type SearchState,
  type StagedMeta,
} from './merge-queue.ts';

/** The executor's cap on steps carried out in one pass. */
export const MAX_TRANSITIONS = 5;

export class Violation extends Error {}

export interface ModelPull {
  number: number;
  version: number;
  labeled: boolean;
  labeledAt: number;
  checks: CheckState;
  draft: boolean;
  merged: boolean;
  /** A revert pull request (fastlane). */
  revert: boolean;
  /** Any tree that holds this pull request fails its run, every attempt. */
  bad: boolean;
  /** Merging it onto anything conflicts. */
  conflicts: boolean;
  /** The break on `main` this pull request undoes. */
  fixes?: number;
}

interface ModelRun {
  id: number;
  attempt: number;
  total: number;
  status: 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | null;
}

interface ModelStaging {
  sha: string;
  committedAt: number;
  meta: StagedMeta;
  tree: readonly string[];
  run?: ModelRun;
  dispatches: number;
}

interface Landing {
  pulls: number[];
  sha: string;
}

interface Search {
  budget: number;
  used: number;
  disturbed: boolean;
}

export interface Stats {
  /** Run attempts started: dispatches and reruns. */
  attempts: number;
  /** Staging commits pushed. */
  stagings: number;
  landings: Landing[];
  dequeued: Array<{ number: number; reason: DequeueReason }>;
  /** Culprit searches that ran to a removal, as [runs used, runs allowed]. */
  searches: Array<[number, number]>;
}

function contentId(pull: ModelPull): string {
  return `pr${pull.number}.${pull.version}`;
}

function headSha(pull: Pick<ModelPull, 'number' | 'version'>): string {
  return `h${pull.number}v${pull.version}`;
}

export class World {
  readonly pulls = new Map<number, ModelPull>();
  main: { sha: string; tree: readonly string[] } = { sha: 'main0', tree: [] };
  staging: ModelStaging | undefined;
  now = 1_000_000;
  readonly stats: Stats = { attempts: 0, stagings: 0, landings: [], dequeued: [], searches: [] };
  private counter = 0;
  private search: Search | undefined;

  private next(): number {
    this.counter += 1;
    return this.counter;
  }

  // --- events -------------------------------------------------------------

  addPull(options: Partial<Pick<ModelPull, 'checks' | 'revert' | 'bad' | 'conflicts' | 'draft' | 'fixes'>> = {}): ModelPull {
    const number = this.pulls.size + 101;
    const pull: ModelPull = {
      number, version: 1, labeled: true, labeledAt: this.next(), checks: 'success',
      draft: false, merged: false, revert: false, bad: false, conflicts: false, ...options,
    };
    this.pulls.set(number, pull);
    return pull;
  }

  unlabel(number: number): void {
    const pull = this.pulls.get(number);
    if (pull !== undefined) pull.labeled = false;
  }

  relabel(number: number): void {
    const pull = this.pulls.get(number);
    if (pull === undefined || pull.merged || pull.labeled) return;
    pull.labeled = true;
    pull.labeledAt = this.next();
  }

  pushHead(number: number): void {
    const pull = this.pulls.get(number);
    if (pull === undefined || pull.merged) return;
    pull.version += 1;
    pull.checks = 'pending';
  }

  settleChecks(number: number, state: 'success' | 'failure'): void {
    const pull = this.pulls.get(number);
    if (pull !== undefined && !pull.merged && pull.checks === 'pending') pull.checks = state;
  }

  setDraft(number: number, draft: boolean): void {
    const pull = this.pulls.get(number);
    if (pull !== undefined && !pull.merged) pull.draft = draft;
  }

  /** Someone pushes to `main` outside the queue. */
  moveMain(): void {
    const id = this.next();
    this.main = { sha: `ext${id}`, tree: [...this.main.tree, `ext${id}`] };
  }

  /** A commit that turns `main` red lands outside the queue; returns the
   *  break's id, which a revert pull request names in `fixes`. */
  breakMain(): number {
    const id = this.next();
    this.main = { sha: `brk${id}`, tree: [...this.main.tree, `break${id}`] };
    return id;
  }

  tick(ms: number): void {
    this.now += ms;
  }

  runInProgress(): boolean {
    return this.staging?.run?.status === 'in_progress';
  }

  /** The staging run finishes. A `flake` fails a first attempt of a tree
   *  that would pass. */
  completeRun(flake = false): void {
    const run = this.staging?.run;
    if (this.staging === undefined || run === undefined || run.status !== 'in_progress') return;
    run.status = 'completed';
    const failed = this.fails(this.staging.tree) || (flake && run.attempt === 1);
    run.conclusion = failed ? 'failure' : 'success';
  }

  cancelRun(): void {
    const run = this.staging?.run;
    if (run === undefined || run.status !== 'in_progress') return;
    run.status = 'completed';
    run.conclusion = 'cancelled';
    if (this.search !== undefined) this.search.disturbed = true;
  }

  // --- what the engine sees -------------------------------------------------

  fails(tree: readonly string[]): boolean {
    const held = new Set(tree);
    for (const id of tree) {
      const broke = /^break(\d+)$/.exec(id);
      if (broke && !held.has(`fix${broke[1]}`)) return true;
    }
    return [...this.pulls.values()].some((pull) => pull.bad && tree.some((id) => id.startsWith(`pr${pull.number}.`)));
  }

  mainIsRed(): boolean {
    return this.fails(this.main.tree);
  }

  private queued(pull: ModelPull): QueuedPull {
    return {
      number: pull.number,
      title: pull.revert ? `revert: change ${pull.number}` : `fix: change ${pull.number}`,
      isDraft: pull.draft,
      headRef: `branch-${pull.number}`,
      headSha: headSha(pull),
      headRepoFullName: 'owner/repo',
      labels: [QUEUE_LABEL],
      labeledAt: String(pull.labeledAt).padStart(8, '0'),
      prRequiredState: pull.checks,
    };
  }

  candidates(): QueuedPull[] {
    return [...this.pulls.values()].filter((pull) => pull.labeled && !pull.merged).map((pull) => this.queued(pull));
  }

  /** The ready pull requests in queue order, worked out apart from the engine. */
  readyInOrder(): QueuedPull[] {
    const ready = this.candidates().filter((pull) => !pull.isDraft && pull.prRequiredState === 'success');
    return ready.sort((left, right) => {
      const lane = Number(isFastlaneRevert(right)) - Number(isFastlaneRevert(left));
      if (lane !== 0) return lane;
      return left.labeledAt.localeCompare(right.labeledAt) || left.number - right.number;
    });
  }

  facts(): QueueFacts {
    const facts: QueueFacts = { repo: 'owner/repo', mainSha: this.main.sha, candidates: this.candidates(), nowMs: this.now };
    if (this.mainIsRed()) facts.mainRed = { workflow: 'Build & Test', runUrl: 'https://example.test/runs/main' };
    const staging = this.staging;
    if (staging !== undefined) {
      const active: ActiveStaging = { stagingSha: staging.sha, committedAtMs: staging.committedAt, meta: staging.meta };
      const run = staging.run;
      if (run !== undefined) {
        const settled = run.status === 'completed';
        const requiredCheckConclusion = settled ? run.conclusion : null;
        let requiredCheckState: CheckState = 'pending';
        if (settled) requiredCheckState = run.conclusion === 'success' ? 'success' : 'failure';
        active.buildRun = {
          id: run.id, attempt: run.attempt, totalRunsForCommit: run.total, status: run.status, conclusion: run.conclusion,
          requiredCheckState, requiredCheckConclusion, url: `https://example.test/runs/${run.id}`, failedJobs: [],
        };
      }
      facts.activeStaging = active;
    }
    return facts;
  }

  // --- carrying out a step ---------------------------------------------------

  private check(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Violation(message);
  }

  private modelPull(number: number): ModelPull {
    const pull = this.pulls.get(number);
    this.check(pull !== undefined, `step names unknown pull request #${number}`);
    return pull;
  }

  private startAttempt(): void {
    this.stats.attempts += 1;
    const search = this.search;
    if (search === undefined) return;
    search.used += 1;
    this.check(search.disturbed || search.used <= search.budget, `culprit search used ${search.used} runs, more than its bound of ${search.budget}`);
  }

  private dispatch(staging: ModelStaging): void {
    staging.dispatches += 1;
    this.check(staging.dispatches <= 2, `staged commit ${staging.sha} was dispatched ${staging.dispatches} times`);
    staging.run = { id: this.next(), attempt: 1, total: staging.dispatches, status: 'in_progress', conclusion: null };
    this.startAttempt();
  }

  private dequeue(number: number, reason: DequeueReason): void {
    const pull = this.modelPull(number);
    if (reason === 'staging-checks-failed') {
      this.check(pull.bad, `#${number} was removed for a staging failure it did not cause`);
      this.check(!this.mainIsRed(), `#${number} was removed for a staging failure while main was red`);
    }
    if (reason === 'merge-conflict') this.check(pull.conflicts, `#${number} was removed for a conflict it does not have`);
    pull.labeled = false;
    this.stats.dequeued.push({ number, reason });
  }

  private checkStage(action: Extract<QueueAction, { kind: 'stage' }>): void {
    const ready = this.readyInOrder();
    const numbers = action.pulls.map((pull) => pull.number);
    this.check(numbers.length >= 1 && numbers.length <= MAX_BATCH, `staged ${numbers.length} pull requests; the cap is ${MAX_BATCH}`);
    this.check(action.baseSha === this.main.sha, 'staged onto a commit that is not main');
    const reverts = ready.filter(isFastlaneRevert);
    this.check(!this.mainIsRed() || reverts.length > 0, 'staged a batch without a revert while main was red');
    if (action.search === undefined) {
      const lane = reverts.length > 0 ? reverts : ready;
      const expected = lane.slice(0, MAX_BATCH).map((pull) => pull.number);
      this.check(numbers.join(',') === expected.join(','), `staged [${numbers.join(',')}] but the ready queue in order is [${expected.join(',')}]`);
      return;
    }
    const suspects = action.search.suspects.map((pull) => pull.number);
    this.check(numbers.join(',') === suspects.slice(0, numbers.length).join(',') && numbers.length < suspects.length, `probe [${numbers.join(',')}] is not a strict prefix of the suspects [${suspects.join(',')}]`);
    for (const suspect of action.search.suspects) {
      this.check(ready.some((pull) => pull.number === suspect.number && pull.headSha === suspect.headSha), `suspect #${suspect.number} is not a ready pull request`);
    }
  }

  private trackSearch(search: SearchState | undefined): void {
    if (search === undefined) {
      this.search = undefined;
      return;
    }
    this.search ??= { budget: maxSearchRuns(search.suspects.length), used: 0, disturbed: false };
  }

  /** Returns whether anything was staged; every pull request may conflict. */
  private stage(action: Extract<QueueAction, { kind: 'stage' }>): boolean {
    this.checkStage(action);
    this.trackSearch(action.search);
    const staged: ModelPull[] = [];
    for (const queuedPull of action.pulls) {
      const pull = this.modelPull(queuedPull.number);
      if (pull.conflicts) this.dequeue(pull.number, 'merge-conflict');
      else staged.push(pull);
    }
    if (staged.length === 0) {
      this.staging = undefined;
      return false;
    }
    const meta: StagedMeta = { baseSha: this.main.sha, pulls: staged.map((pull) => ({ number: pull.number, headSha: headSha(pull) })) };
    if (action.search !== undefined) meta.search = action.search;
    const tree = [...this.main.tree, ...staged.flatMap((pull) => (pull.fixes === undefined ? [contentId(pull)] : [contentId(pull), `fix${pull.fixes}`]))];
    this.staging = { sha: `stg${this.next()}`, committedAt: this.now, meta, tree, dispatches: 0 };
    this.stats.stagings += 1;
    this.dispatch(this.staging);
    return true;
  }

  private land(action: Extract<QueueAction, { kind: 'land' }>): void {
    const staging = this.staging;
    this.check(staging !== undefined && staging.sha === action.stagingSha, 'landing a commit that is not staged');
    this.check(staging.meta.baseSha === this.main.sha, 'landing a batch built on a commit that is no longer main');
    this.check(staging.run?.status === 'completed' && staging.run.conclusion === 'success', 'landing a commit whose run did not pass');
    this.check(!this.fails(staging.tree), 'landing a tree that fails');
    const landed = staging.meta.pulls.map((pull) => this.modelPull(pull.number));
    this.check(!this.mainIsRed() || landed.every((pull) => pull.revert), 'landing a normal pull request while main is red');
    for (const pull of landed) {
      this.check(pull.labeled && !pull.merged && headSha(pull) === staging.meta.pulls.find((entry) => entry.number === pull.number)?.headSha, `landing #${pull.number}, which is not queued at the staged head`);
      pull.merged = true;
    }
    this.main = { sha: staging.sha, tree: staging.tree };
    this.stats.landings.push({ pulls: landed.map((pull) => pull.number), sha: staging.sha });
    if (action.search === undefined) this.staging = undefined;
  }

  private finishSearch(reason: DequeueReason): void {
    const search = this.search;
    if (search !== undefined && reason === 'staging-checks-failed' && !search.disturbed) this.stats.searches.push([search.used, search.budget]);
    this.search = undefined;
  }

  /** A step that moves a staged batch on is not taken for normal pull
   *  requests while a revert is ready. */
  private checkRevertsFirst(action: QueueAction): void {
    const movesOn = action.kind === 'land' || action.kind === 'wait-staging' || action.kind === 'rerun-staging' || action.kind === 'dispatch-staging';
    if (!movesOn) return;
    const revertReady = this.readyInOrder().some(isFastlaneRevert);
    this.check(!revertReady || action.pulls.every(isFastlaneRevert), `a batch with normal pull requests went ahead (${action.kind}) while a revert was ready`);
  }

  /** Carries out one step; returns whether the pass goes on to another. */
  apply(action: QueueAction): boolean {
    this.checkRevertsFirst(action);
    if (action.kind === 'stage') {
      return !this.stage(action);
    }
    if (action.kind === 'land') {
      this.land(action);
      return true;
    }
    if (action.kind === 'dequeue') {
      for (const pull of action.pulls) this.dequeue(pull.number, action.reason);
      this.finishSearch(action.reason);
      if (action.cleanStaging) this.staging = undefined;
      return true;
    }
    if (action.kind === 'dispatch-staging') {
      this.check(this.staging !== undefined, 'dispatching with nothing staged');
      this.dispatch(this.staging);
    }
    if (action.kind === 'rerun-staging') {
      const run = this.staging?.run;
      this.check(run !== undefined && run.conclusion === 'failure' && run.attempt === 1, 'rerunning a run that is not a failed first attempt');
      run.attempt = 2;
      run.status = 'in_progress';
      run.conclusion = null;
      this.startAttempt();
    }
    const cleans = action.kind === 'clean-staging' || (action.kind === 'wait-pr-checks' && action.cleanStaging === true);
    if (cleans) {
      this.staging = undefined;
      this.search = undefined;
    }
    return false;
  }

  /** One run of the queue workflow. Returns the steps it took. */
  pass(): QueueAction[] {
    const steps: QueueAction[] = [];
    for (let step = 0; step < MAX_TRANSITIONS; step++) {
      const action = decideQueueStep(this.facts());
      steps.push(action);
      if (!this.apply(action)) break;
    }
    return steps;
  }

  /** Lets runs finish and passes run until the queue rests. Returns false
   *  when it does not rest within `limit` rounds. */
  drain(limit = 200): boolean {
    for (let round = 0; round < limit; round++) {
      const last = this.pass().at(-1);
      if (this.runInProgress()) {
        this.completeRun();
        continue;
      }
      const resting = last?.kind === 'idle' || last?.kind === 'hold-main-red' || last?.kind === 'wait-pr-checks';
      if (resting) return true;
      this.tick(61_000);
    }
    return false;
  }
}
