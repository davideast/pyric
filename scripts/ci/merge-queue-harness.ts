import {
  QUEUE_LABEL,
  STAGING_BRANCH,
  formatStagingTrailers,
  parseStagingCommit,
  type StagedMeta,
} from './merge-queue.ts';
import type { QueueIo } from './merge-queue-github.ts';

export const MAIN = '1'.repeat(40);
export const HEAD_A = 'a'.repeat(40);
export const HEAD_B = 'b'.repeat(40);
export const HEAD_C = 'd'.repeat(40);
export const STAGED = 'c'.repeat(40);
export const CHAIN = 'e'.repeat(40);
export const WRAPPED = 'f'.repeat(40);
export const NOW = Date.parse('2026-11-14T12:00:00Z');
export const RUN_URL = 'https://github.com/owner/repo/actions/runs/500';
export const GREEN_RUN: RunItem = {
  id: 500,
  run_attempt: 1,
  status: 'completed',
  conclusion: 'success',
  html_url: RUN_URL,
  event: 'workflow_dispatch',
  actor: { login: 'github-actions[bot]' },
};

export interface FakePull {
  number: number;
  title: string;
  headRef: string;
  headSha: string;
  labels: string[];
  labeledAt?: string;
}

export interface RunItem {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  event?: string;
  head_branch?: string;
  actor?: { login?: string } | null;
}

export interface PullFileItem {
  filename: string;
  previous_filename?: string;
}

/** A remote repository small enough to read: branches, pull requests, commit
 *  messages and trees by sha, and the runs of each workflow. */
export interface Remote {
  main: string;
  branches: Record<string, string>;
  pulls: FakePull[];
  messages: Record<string, string>;
  trees: Record<string, string>;
  greenHeads: Set<string>;
  stagingRuns: RunItem[];
  mainRuns: Record<string, RunItem[]>;
  filesByPr: Record<number, Array<string | PullFileItem>>;
  conflicts: Set<string>;
  /** Ancestor pairs `"<ancestor>:<descendant>"` for `git merge-base --is-ancestor`. */
  ancestors: Set<string>;
  /** What a push to main is refused with. */
  pushRefusal?: string;
  /** What a push to the staging branch is refused with. */
  stagingPushRefusal?: string;
  /** Called in place of moving main, to model someone else's push winning. */
  onPushMain?: () => void;
}

export interface Harness {
  remote: Remote;
  gh: string[][];
  git: string[][];
  comments: Array<{ pull: number; text: string }>;
  logs: string[];
  io: QueueIo;
}

export function pull(number: number, headSha: string, labels: string[] = [QUEUE_LABEL]): FakePull {
  return { number, title: `fix(cli): change ${number}`, headRef: `fix/change-${number}`, headSha, labels };
}

export function stagedMessage(meta: StagedMeta): string {
  return `Merge queue batch\n\n${formatStagingTrailers(meta)}`;
}

function normalizePullFiles(entries: ReadonlyArray<string | PullFileItem> | undefined): PullFileItem[] {
  if (entries === undefined) return [];
  const items: PullFileItem[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') items.push({ filename: entry });
    else items.push(entry);
  }
  return items;
}

function pullTouchesWorkflows(remote: Remote, item: FakePull): boolean {
  if (!item.labels.includes(QUEUE_LABEL)) return false;
  for (const file of normalizePullFiles(remote.filesByPr[item.number])) {
    if (file.filename.startsWith('.github/workflows/')) return true;
    if (file.previous_filename?.startsWith('.github/workflows/')) return true;
  }
  return false;
}

function stripPrefix(value: string | undefined, prefix: string): string {
  if (value === undefined) return '';
  if (value.startsWith(prefix)) return value.slice(prefix.length);
  return value;
}

function matchesLsRemote(ref: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  for (const pattern of patterns) {
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (ref.startsWith(prefix)) return true;
    } else if (ref === pattern) {
      return true;
    }
  }
  return false;
}

export function createHarness(initial: Partial<Remote>): Harness {
  const remote: Remote = {
    main: MAIN,
    branches: {},
    pulls: [],
    messages: {},
    trees: {},
    greenHeads: new Set(),
    stagingRuns: [],
    mainRuns: {},
    filesByPr: {},
    conflicts: new Set(),
    ancestors: new Set(),
    ...initial,
  };
  const gh: string[][] = [];
  const git: string[][] = [];
  const comments: Harness['comments'] = [];
  const logs: string[] = [];
  const files = new Map<string, string>();
  let local: string[] = [];

  const treeOf = (sha: string): string => remote.trees[sha] ?? `tree-of-${sha}`;

  function push(args: string[]): string {
    if (args.includes('--delete')) {
      const branch = args.at(-1);
      if (branch !== undefined) delete remote.branches[branch];
      return '';
    }
    const spec = args.at(-1) ?? '';
    const [sha = '', ref = ''] = spec.split(':');
    const branch = stripPrefix(ref, 'refs/heads/');
    if (branch !== 'main') {
      const touchesWorkflows = remote.pulls.some((item) => pullTouchesWorkflows(remote, item));
      if (branch === STAGING_BRANCH && remote.stagingPushRefusal !== undefined && touchesWorkflows) {
        throw new Error(remote.stagingPushRefusal);
      }
      remote.branches[branch] = sha;
      return '';
    }
    if (remote.pushRefusal !== undefined) throw new Error(remote.pushRefusal);
    if (remote.onPushMain !== undefined) {
      remote.onPushMain();
      throw new Error('! [rejected] main -> main (fetch first)');
    }
    const message = remote.messages[sha] ?? '';
    const landed = parseStagingCommit(message)?.pulls ?? [];
    remote.pulls = remote.pulls.filter((item) => !landed.some((entry) => entry.number === item.number));
    remote.main = sha;
    return '';
  }

  function runGit(args: string[]): string {
    git.push(args);
    const [command] = args;
    if (command === 'ls-remote' && args.includes('refs/heads/main')) return `${remote.main}\trefs/heads/main\n`;
    if (command === 'ls-remote') {
      const patterns = args.slice(2);
      const lines: string[] = [];
      for (const [branch, sha] of Object.entries(remote.branches)) {
        const ref = `refs/heads/${branch}`;
        if (matchesLsRemote(ref, patterns)) lines.push(`${sha}\t${ref}\n`);
      }
      return lines.join('');
    }
    if (command === 'merge-base' && args[1] === '--is-ancestor') {
      const candidate = args[2] ?? '';
      const descendant = args[3] ?? '';
      if (candidate === descendant || remote.ancestors.has(`${candidate}:${descendant}`)) return '';
      throw new Error('not an ancestor');
    }
    if (command === 'checkout') local = [];
    if (command === 'merge' && args[1] === '--no-ff') {
      const head = args.at(-1) ?? '';
      if (remote.conflicts.has(head)) throw new Error('CONFLICT (content): Merge conflict in packages/cli/src/serve/rules.ts');
      local.push(args[3] ?? '');
    }
    if (command === 'commit' && args[1] === '--amend') local[local.length - 1] = args[3] ?? '';
    if (command === 'rev-parse' && args[1] === 'HEAD') {
      remote.messages[CHAIN] = local.at(-1) ?? '';
      return `${CHAIN}\n`;
    }
    if (command === 'rev-parse') {
      const rawTarget = args[1] ?? '';
      const target = rawTarget.replace('^{tree}', '');
      const sha = target === 'HEAD' ? CHAIN : target;
      return `${treeOf(sha)}\n`;
    }
    if (command === 'commit-tree') {
      remote.messages[WRAPPED] = args.at(-1) ?? '';
      return `${WRAPPED}\n`;
    }
    if (command === 'push') return push(args);
    return '';
  }

  function runsFor(path: string): RunItem[] {
    const match = /^actions\/workflows\/([^/]+)\/runs\?/.exec(path);
    const workflow = match?.[1] ?? '';
    if (path.includes('branch=main&')) return remote.mainRuns[workflow] ?? [];
    return remote.stagingRuns;
  }

  function runGh(args: string[]): string {
    gh.push(args);
    if (args[0] !== 'api') return '';
    const methodIdx = args.indexOf('-X');
    let method = 'GET';
    const nextArg = args[methodIdx + 1];
    if (methodIdx !== -1 && nextArg !== undefined) method = nextArg;
    const repoArg = args.find((arg) => arg.startsWith('repos/owner/repo/'));
    const path = stripPrefix(repoArg, 'repos/owner/repo/');
    if (method === 'GET' && path === 'branches/main') return JSON.stringify({ commit: { sha: remote.main } });
    if (method === 'GET' && path.startsWith('pulls?')) {
      const payload = remote.pulls.map((item) => {
        const minute = String(item.number % 60).padStart(2, '0');
        const createdAt = item.labeledAt ?? `2026-11-14T11:${minute}:00Z`;
        return {
          number: item.number,
          title: item.title,
          state: 'open',
          draft: false,
          created_at: createdAt,
          head: { ref: item.headRef, sha: item.headSha, repo: { full_name: 'owner/repo' } },
          labels: item.labels.map((name) => ({ name })),
        };
      });
      return JSON.stringify(payload);
    }
    const single = /^pulls\/(\d+)$/.exec(path);
    if (method === 'GET' && single) {
      const found = remote.pulls.find((item) => item.number === Number(single[1]));
      const state = found === undefined ? 'closed' : 'open';
      const sha = found?.headSha ?? '';
      return JSON.stringify({ state, head: { sha } });
    }
    if (method === 'GET' && /^issues\/\d+\/events\?/.test(path)) return '[]';
    const check = /^commits\/([0-9a-f]+)\/check-runs\?/.exec(path);
    if (method === 'GET' && check) {
      const head = check[1] ?? '';
      if (remote.greenHeads.has(head)) {
        return JSON.stringify({
          check_runs: [{ name: 'CI / required', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }],
        });
      }
      return JSON.stringify({ check_runs: [] });
    }
    const commit = /^commits\/([0-9a-f]+)$/.exec(path);
    if (method === 'GET' && commit) {
      const sha = commit[1] ?? '';
      const message = remote.messages[sha] ?? '';
      return JSON.stringify({ commit: { message, committer: { date: '2026-11-14T11:55:00Z' } } });
    }
    if (method === 'GET' && path.startsWith('actions/workflows/')) return JSON.stringify({ workflow_runs: runsFor(path) });
    if (method === 'GET' && /^actions\/runs\/\d+\/attempts\/\d+\/jobs\?/.test(path)) return JSON.stringify({ jobs: [] });
    const filesOf = /^pulls\/(\d+)\/files\?/.exec(path);
    if (method === 'GET' && filesOf) return JSON.stringify(normalizePullFiles(remote.filesByPr[Number(filesOf[1])]));
    const label = /^issues\/(\d+)\/labels\/merge-queue$/.exec(path);
    if (method === 'DELETE' && label) {
      const targetPr = Number(label[1]);
      remote.pulls = remote.pulls.map((item) => {
        if (item.number !== targetPr) return item;
        return { ...item, labels: item.labels.filter((name) => name !== QUEUE_LABEL) };
      });
      return '{}';
    }
    const commented = /^issues\/(\d+)\/comments$/.exec(path);
    if (method === 'POST' && commented) {
      const file = stripPrefix(args.at(-1), 'body=@');
      comments.push({ pull: Number(commented[1]), text: files.get(file) ?? '' });
      return '{}';
    }
    throw new Error(`unexpected gh api ${method} ${path}`);
  }

  const io: QueueIo = {
    repo: 'owner/repo',
    now: () => NOW,
    log: (text) => { logs.push(text); },
    writeFile: (name, text) => {
      files.set(`/scratch/${name}`, text);
      return `/scratch/${name}`;
    },
    git: runGit,
    gh: runGh,
  };
  return { remote, gh, git, comments, logs, io };
}

/** Two green pull requests staged together on a green run. */
export function greenBatch(extra: Partial<Remote> = {}): Harness {
  const meta: StagedMeta = { baseSha: MAIN, pulls: [{ number: 101, headSha: HEAD_A }, { number: 102, headSha: HEAD_B }] };
  return createHarness({
    branches: { [STAGING_BRANCH]: STAGED },
    pulls: [pull(101, HEAD_A), pull(102, HEAD_B)],
    messages: { [STAGED]: stagedMessage(meta) },
    greenHeads: new Set([HEAD_A, HEAD_B, STAGED]),
    stagingRuns: [GREEN_RUN],
    ...extra,
  });
}

export function mutations(h: Harness): { git: string[][]; gh: string[][] } {
  return {
    git: h.git.filter((args) => args[0] !== 'ls-remote'),
    gh: h.gh.filter((args) => args[0] !== 'api' || args.includes('-X')),
  };
}
