import { describe, expect, test } from 'bun:test';
import { roundMeter } from './model-meter.ts';
import { costOf, priceOf, UNKNOWN_MODEL_PRICE } from './model-prices.ts';
import { usageTap } from './usage-tap.ts';

describe('priceOf and costOf', () => {
  test('prices a model by its longest table entry, and one it does not know at the highest rate', () => {
    expect(priceOf('claude-opus-5-5')).toEqual({ input: 4, output: 20 });
    expect(priceOf('claude-opus-5')).toEqual({ input: 5, output: 25 });
    expect(priceOf('claude-opus-4-8')).toEqual({ input: 5, output: 25 });
    expect(priceOf('claude-sonnet-5-5[1m]')).toEqual({ input: 2, output: 10 });
    expect(priceOf('claude-opus-5-50')).toEqual({ input: 5, output: 25 });
    expect(priceOf('some-new-model')).toEqual(UNKNOWN_MODEL_PRICE);
    expect(priceOf(undefined)).toEqual(UNKNOWN_MODEL_PRICE);
  });

  test('charges cache writes at twice input, reads at a tenth, and fast mode twice', () => {
    const tokens = { input: 1_000_000, output: 1_000_000, cacheCreation: 1_000_000, cacheRead: 1_000_000 };
    expect(costOf(tokens, 'claude-sonnet-5-5')).toBeCloseTo(2 + 10 + 4 + 0.2, 10);
    expect(costOf(tokens, 'claude-sonnet-5-5', 'fast')).toBeCloseTo(2 * (2 + 10 + 4 + 0.2), 10);
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

describe('roundMeter', () => {
  test('stops a run at its cap and every run at the round’s total', () => {
    const round = roundMeter(1);
    const first = round.run(0.6);
    const second = round.run(0.6);
    const request = first.charge();
    request.set(0.2);
    request.set(0.4);
    request.set(0.3);
    expect(first.spentUsd()).toBe(0.4);
    expect(first.capReached()).toBeUndefined();
    first.charge().set(0.2);
    expect(first.capReached()).toBe('run-cap');
    expect(second.capReached()).toBeUndefined();
    second.charge().set(0.4);
    expect(round.spentUsd()).toBeCloseTo(1, 12);
    expect(second.capReached()).toBe('round-cap');
  });
});
