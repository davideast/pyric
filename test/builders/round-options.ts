/**
 * The `round` command's options. `--models`, `--max-budget-usd` and
 * `--max-round-usd` are required and have no default: a round spends money
 * only at caps the owner typed, one per run and one for the whole round.
 *
 *   round <round> --models <id,id> --max-budget-usd <usd> --max-round-usd <usd>
 *         [--builder claude|<script>] [--briefs <dir>]
 *         [--packages <dir> | --build] [--concurrency 1|2] [--token-file <path>]
 *
 * `--token-file` names the file holding the forwarder's token
 * (`harness-token.ts`); without it the token comes from
 * `CLAUDE_CODE_OAUTH_TOKEN`.
 */
import { resolve } from 'node:path';
import { flagValue, positionals, rejectUnknownFlags, UsageError } from './cli-args.ts';

export interface RoundOptions {
  round: string;
  models: string[];
  /** Each builder run's cap, the same for every model. */
  maxBudgetUsd: number;
  /** The whole round's cap. The round starts only when its runs times the run cap fit under it. */
  maxRoundUsd: number;
  /** `claude`, or the path of a scripted builder run with node. */
  builder: string;
  /** Where the briefs are; the data root's `briefs/<round>/` when not given. */
  briefs?: string;
  packages?: string;
  build: boolean;
  /** Builders at once, each holding a heavy-run slot. At most two. */
  concurrency: number;
  /** The file holding the forwarder's token; the environment's token when not given. */
  tokenFile?: string;
}

const ROUND_NAME = /^[a-z0-9][a-z0-9-]*$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9.:@_-]*$/;
export const MAX_CONCURRENCY = 2;

export const ROUND_FLAGS = ['--models', '--max-budget-usd', '--max-round-usd', '--builder', '--briefs', '--packages', '--build', '--concurrency', '--token-file'];
const VALUE_FLAGS = new Set(ROUND_FLAGS.filter((flag) => flag !== '--build'));

function required(args: readonly string[], flag: string): string {
  const value = flagValue(args, flag);
  if (value === undefined) throw new UsageError(`${flag} is required and has no default`);
  return value;
}

/** A positive, finite number of dollars. */
export function parseBudget(raw: string, flag = '--max-budget-usd'): number {
  const usd = Number(raw);
  const isPositiveAmount = /^\d+(\.\d+)?$/.test(raw) && Number.isFinite(usd) && usd > 0;
  if (!isPositiveAmount) throw new UsageError(`${flag} takes a positive number of dollars, received "${raw}"`);
  return usd;
}

export function parseModels(raw: string): string[] {
  const models = raw.split(',').map((model) => model.trim()).filter((model) => model !== '');
  const invalid = models.filter((model) => !MODEL_ID.test(model));
  if (models.length === 0 || invalid.length > 0) throw new UsageError(`--models takes model ids separated by commas, received "${raw}"`);
  if (new Set(models).size !== models.length) throw new UsageError(`--models names a model twice: "${raw}"`);
  return models;
}

function parseConcurrency(raw: string | undefined): number {
  if (raw === undefined) return MAX_CONCURRENCY;
  const value = Number(raw);
  const isAllowed = Number.isInteger(value) && value >= 1 && value <= MAX_CONCURRENCY;
  if (!isAllowed) throw new UsageError(`--concurrency takes 1 or ${MAX_CONCURRENCY}, received "${raw}"`);
  return value;
}

export function parseRoundOptions(args: readonly string[]): RoundOptions {
  rejectUnknownFlags(args, ROUND_FLAGS);
  const [round, ...extra] = positionals(args, VALUE_FLAGS);
  if (round === undefined || !ROUND_NAME.test(round)) throw new UsageError('round takes a round name: lowercase letters, digits and dashes');
  if (extra.length > 0) throw new UsageError(`unexpected arguments: ${extra.join(' ')}`);
  const build = args.includes('--build');
  const packages = flagValue(args, '--packages');
  if (build && packages !== undefined) throw new UsageError('--build and --packages are exclusive');
  const builder = flagValue(args, '--builder') ?? 'claude';
  const briefs = flagValue(args, '--briefs');
  const tokenFile = flagValue(args, '--token-file');
  return {
    round,
    models: parseModels(required(args, '--models')),
    maxBudgetUsd: parseBudget(required(args, '--max-budget-usd')),
    maxRoundUsd: parseBudget(required(args, '--max-round-usd'), '--max-round-usd'),
    builder: builder === 'claude' ? builder : resolve(builder),
    ...(briefs === undefined ? {} : { briefs: resolve(briefs) }),
    ...(packages === undefined ? {} : { packages: resolve(packages) }),
    build,
    concurrency: parseConcurrency(flagValue(args, '--concurrency')),
    ...(tokenFile === undefined ? {} : { tokenFile: resolve(tokenFile) }),
  };
}

/** A run's id: its brief and its model, in characters any path or project id takes. */
export function runId(briefId: string, model: string): string {
  const slug = model.toLowerCase().replace(/^claude-/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${briefId}-${slug}`;
}
