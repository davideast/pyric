// The model channel's record lines and the environment a builder gets. The
// forwarder and the bridge over real sockets are in model-forwarder.test.ts.
import { describe, expect, test } from 'bun:test';
import { parseHead } from './http-head.ts';
import { channelEnvironment, channelEvent, meteredCostUsd } from './model-channel.ts';

describe('channelEnvironment', () => {
  test('points the builder at the bridge in plain HTTP on loopback, and sets no proxy', () => {
    expect(channelEnvironment(4123)).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123' });
  });
});

describe('channelEvent', () => {
  const time = new Date('2026-10-29T00:00:00.000Z');

  test('classifies the host a refused request named and keeps its path without the query', () => {
    const head = parseHead('GET /v1/models?limit=1000 HTTP/1.1\r\nHost: oauth2.googleapis.com');
    const event = channelEvent('oauth2.googleapis.com', 'GET /v1/models?limit=1000 HTTP/1.1', head, { action: 'refused', reason: 'method', status: 403, usage: undefined, costUsd: null }, time);
    expect(event).toMatchObject({ time: time.toISOString(), layer: 'model-channel', kind: 'request', via: 'forwarder', host: 'oauth2.googleapis.com', google: true, method: 'GET', path: '/v1/models', action: 'refused', reason: 'method', tokens: null, costUsd: null });
  });

  test('sums the metered cost of a run’s forwarded requests', () => {
    const tokens = { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 };
    const forwarded = (costUsd: number) => channelEvent('api.anthropic.com', 'POST /v1/messages HTTP/1.1', undefined, { action: 'forwarded', reason: null, status: 200, usage: { model: 'm', tokens, speed: undefined }, costUsd }, time);
    const refused = channelEvent('api.anthropic.com', '', undefined, { action: 'refused', reason: 'run-cap', status: 403, usage: undefined, costUsd: null }, time);
    expect(meteredCostUsd([forwarded(0.25), refused, forwarded(0.5)])).toBe(0.75);
  });
});
