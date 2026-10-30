import { describe, expect, test } from 'bun:test';
import { MAX_IN_FLIGHT, roundMeter, type Reservation } from './model-meter.ts';
import { costOf, PROMPT_OVERHEAD_TOKENS, priceOf, UNKNOWN_MODEL_PRICE, worstCaseUsd } from './model-prices.ts';
import { usageTap } from './usage-tap.ts';

describe('priceOf and costOf', () => {
  test('prices each model by its exact id, at the rates on the pricing page', () => {
    expect(priceOf('claude-opus-5-5')).toEqual({ input: 4, output: 20 });
    expect(priceOf('claude-opus-5')).toEqual({ input: 5, output: 25 });
    expect(priceOf('claude-opus-4-8')).toEqual({ input: 5, output: 25 });
    expect(priceOf('claude-sonnet-5-5')).toEqual({ input: 2, output: 10 });
    expect(priceOf('claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5 });
    for (const opus4 of ['claude-opus-4-0', 'claude-opus-4-20250514', 'claude-opus-4-1', 'claude-opus-4-1-20250805']) {
      expect(priceOf(opus4)).toEqual({ input: 15, output: 75 });
    }
  });

  test('charges any id it does not name exactly at the highest rate in the table', () => {
    expect(UNKNOWN_MODEL_PRICE).toEqual({ input: 15, output: 75 });
    for (const unknown of ['claude-opus-4', 'claude-opus-5-50', 'claude-sonnet-5-5[1m]', 'claude-opus-4-1-20990101', 'some-new-model', undefined]) {
      expect(priceOf(unknown)).toEqual(UNKNOWN_MODEL_PRICE);
    }
  });

  test('charges Haiku 5.5 its long-prompt rate always, and Sonnet 4 the highest rate past 200K tokens', () => {
    expect(priceOf('claude-haiku-5-5', 10)).toEqual({ input: 0.5, output: 2.5 });
    expect(priceOf('claude-sonnet-4-5', 200_000)).toMatchObject({ input: 3, output: 15 });
    expect(priceOf('claude-sonnet-4-5', 200_001)).toEqual(UNKNOWN_MODEL_PRICE);
  });

  test('charges cache writes at twice input, reads at a tenth, fast mode twice and US-only inference 1.1 times', () => {
    const tokens = { input: 1_000_000, output: 1_000_000, cacheCreation: 1_000_000, cacheRead: 1_000_000 };
    expect(costOf(tokens, 'claude-sonnet-5-5')).toBeCloseTo(2 + 10 + 4 + 0.2, 10);
    expect(costOf(tokens, 'claude-sonnet-5-5', { speed: 'fast' })).toBeCloseTo(2 * (2 + 10 + 4 + 0.2), 10);
    expect(costOf(tokens, 'claude-sonnet-5-5', { usOnly: true })).toBeCloseTo(1.1 * (2 + 10 + 4 + 0.2), 10);
  });

  test('prices a request’s worst case as every prompt token a cache write plus all of max_tokens', () => {
    const promptTokens = 1_000 + PROMPT_OVERHEAD_TOKENS;
    expect(worstCaseUsd(1_000, 'claude-sonnet-5-5', 64_000)).toBeCloseTo((promptTokens * 2 * 2 + 64_000 * 10) / 1e6, 12);
    expect(worstCaseUsd(1_000, 'mystery', 1_000)).toBeCloseTo((promptTokens * 15 * 2 + 1_000 * 75) / 1e6, 12);
    const tokens = { input: 0, output: 64_000, cacheCreation: promptTokens, cacheRead: 0 };
    expect(worstCaseUsd(1_000, 'claude-opus-5-5', 64_000, { speed: 'fast' })).toBeCloseTo(costOf(tokens, 'claude-opus-5-5', { speed: 'fast' }), 12);
  });
});

describe('usageTap', () => {
  test('reads a stream’s usage across events and chunk boundaries, keeping the largest of each figure', () => {
    const tap = usageTap('text/event-stream; charset=utf-8', 'claude-asked-for');
    const stream = [
      'data: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":5}}}\r\n',
      'data: {"type":"message_delta","usage":{"output_tokens":30}}\n',
      'data: {"type":"message_delta","usage":{"output_tokens":20,"speed":"fast"}}\n',
    ].join('');
    for (let at = 0; at < stream.length; at += 7) tap.write(Buffer.from(stream.slice(at, at + 7)));
    expect(tap.current()).toEqual({ model: 'claude-haiku-5-5', tokens: { input: 10, output: 30, cacheCreation: 0, cacheRead: 5 }, speed: 'fast' });
  });

  test('reads a JSON response’s usage, falling back to the model the request asked for', () => {
    const tap = usageTap('application/json', 'claude-asked-for');
    tap.write(Buffer.from('{"usage":{"input_tokens":3,'));
    expect(tap.current()).toBeUndefined();
    tap.write(Buffer.from('"output_tokens":4}}'));
    expect(tap.current()).toEqual({ model: 'claude-asked-for', tokens: { input: 3, output: 4, cacheCreation: 0, cacheRead: 0 }, speed: undefined });
  });

  test('finds no usage in an error or a token count', () => {
    const tap = usageTap('application/json', undefined);
    tap.write(Buffer.from('{"input_tokens":12}'));
    expect(tap.current()).toBeUndefined();
  });
});

const reserved = (result: Reservation | string): Reservation => {
  if (typeof result === 'string') throw new Error(`refused: ${result}`);
  return result;
};

describe('roundMeter', () => {
  test('counts each open reservation in full, so requests at once can’t pass the run’s cap between them', () => {
    const run = roundMeter(100).run(1);
    const first = reserved(run.reserve(0.6));
    expect(run.reserve(0.6)).toBe('run-cap');
    expect(run.spentUsd()).toBe(0.6);
    first.settle(0.1);
    expect(run.spentUsd()).toBe(0.1);
    reserved(run.reserve(0.9)).settle(0.9);
    expect(run.reserve(0.01)).toBe('run-cap');
    expect(run.reserve(0)).not.toBe('run-cap');
  });

  test('counts every run’s reservations against the round’s total', () => {
    const round = roundMeter(1);
    const first = round.run(0.8);
    const second = round.run(0.8);
    reserved(first.reserve(0.7));
    expect(second.reserve(0.4)).toBe('round-cap');
    reserved(second.reserve(0.3));
    expect(round.spentUsd()).toBeCloseTo(1, 12);
  });

  test('lets two requests of a run be in flight at once, and settles each only once', () => {
    const run = roundMeter(100).run(10);
    const open = [reserved(run.reserve(0.1)), reserved(run.reserve(0.1))];
    expect(open).toHaveLength(MAX_IN_FLIGHT);
    expect(run.reserve(0.1)).toBe('in-flight');
    open[0]?.settle(0.05);
    open[0]?.settle(5);
    expect(open[0]?.chargedUsd()).toBe(0.05);
    expect(run.inFlight()).toBe(1);
    expect(typeof run.reserve(0.1)).toBe('object');
  });
});
