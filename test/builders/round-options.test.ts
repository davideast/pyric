import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { UsageError } from './cli-args.ts';
import { parseBudget, parseRoundOptions, runId } from './round-options.ts';
import { possibleSpendUsd, spendProblems } from './round.ts';

const BASE = ['r1', '--models', 'claude-haiku-5-5,claude-sonnet-5-5', '--max-budget-usd', '2.50', '--max-round-usd', '15'];

describe('parseRoundOptions', () => {
  test('reads a round with its models and caps, and defaults to the claude builder, two at once', () => {
    expect(parseRoundOptions(BASE)).toEqual({ round: 'r1', models: ['claude-haiku-5-5', 'claude-sonnet-5-5'], maxBudgetUsd: 2.5, maxRoundUsd: 15, builder: 'claude', build: false, concurrency: 2 });
  });

  test('requires --max-budget-usd, with no default', () => {
    expect(() => parseRoundOptions(['r1', '--models', 'claude-haiku-5-5', '--max-round-usd', '5'])).toThrow(new UsageError('--max-budget-usd is required and has no default'));
    expect(() => parseRoundOptions(['r1', '--models', 'claude-haiku-5-5', '--max-budget-usd'])).toThrow(new UsageError('--max-budget-usd takes a value'));
  });

  test('requires --max-round-usd, with no default', () => {
    expect(() => parseRoundOptions(['r1', '--models', 'claude-haiku-5-5', '--max-budget-usd', '2'])).toThrow(new UsageError('--max-round-usd is required and has no default'));
    expect(() => parseRoundOptions(['r1', '--models', 'claude-haiku-5-5', '--max-budget-usd', '2', '--max-round-usd', '0'])).toThrow(new UsageError('--max-round-usd takes a positive number of dollars, received "0"'));
  });

  test('requires --models', () => {
    expect(() => parseRoundOptions(['r1', '--max-budget-usd', '2', '--max-round-usd', '5'])).toThrow(new UsageError('--models is required and has no default'));
    expect(() => parseRoundOptions(['r1', '--models', 'a,a', '--max-budget-usd', '2', '--max-round-usd', '5'])).toThrow(new UsageError('--models names a model twice: "a,a"'));
  });

  test('takes a scripted builder by path, briefs and packages by path, and one at once', () => {
    const options = parseRoundOptions([...BASE, '--builder', 'fixtures/fake-builder.mjs', '--briefs', 'b', '--packages', 'p', '--concurrency', '1']);
    expect(options).toMatchObject({ builder: resolve('fixtures/fake-builder.mjs'), briefs: resolve('b'), packages: resolve('p'), concurrency: 1 });
  });

  test('refuses more than two at once, both --build and --packages, a bad round name, and stray arguments', () => {
    expect(() => parseRoundOptions([...BASE, '--concurrency', '3'])).toThrow(new UsageError('--concurrency takes 1 or 2, received "3"'));
    expect(() => parseRoundOptions([...BASE, '--build', '--packages', 'p'])).toThrow(new UsageError('--build and --packages are exclusive'));
    expect(() => parseRoundOptions(['R 1', ...BASE.slice(1)])).toThrow(UsageError);
    expect(() => parseRoundOptions([...BASE, 'extra'])).toThrow(new UsageError('unexpected arguments: extra'));
    expect(() => parseRoundOptions([...BASE, '--yes'])).toThrow(new UsageError('unknown option: --yes'));
  });
});

describe('parseBudget', () => {
  test('takes a positive number of dollars and nothing else', () => {
    expect(parseBudget('5')).toBe(5);
    expect(parseBudget('0.25')).toBe(0.25);
    for (const raw of ['0', '-1', 'Infinity', '1e3', '', 'five', '1,5']) expect(() => parseBudget(raw)).toThrow(UsageError);
  });
});

describe('spendProblems', () => {
  test('starts a round only when every run at its cap fits under the round cap', () => {
    expect(possibleSpendUsd(6, 2.5)).toBe(15);
    expect(spendProblems(6, { maxBudgetUsd: 2.5, maxRoundUsd: 15 })).toEqual([]);
    expect(spendProblems(3, { maxBudgetUsd: 0.1, maxRoundUsd: 0.3 })).toEqual([]);
    expect(spendProblems(7, { maxBudgetUsd: 2.5, maxRoundUsd: 15 })).toEqual(['7 runs at $2.50 each could spend $17.50, over --max-round-usd $15.00']);
  });
});

describe('runId', () => {
  test('joins the brief and the model in path-safe characters', () => {
    expect(runId('r1-1', 'claude-haiku-5-5')).toBe('r1-1-haiku-5-5');
    expect(runId('r1-2', 'Sonnet@5.5')).toBe('r1-2-sonnet-5-5');
  });
});
