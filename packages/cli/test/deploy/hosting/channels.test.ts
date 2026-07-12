/**
 * Tests for preview channels. Mock fetch and pin the REST request
 * shapes against firebase-tools' `createChannel` / `getChannel`
 * (clones/firebase-tools/src/hosting/api.ts:332-345 / :274-290) +
 * the discriminated outcome for each failure branch. Branch-name
 * sanitization and --channel-ttl parsing are pure-unit tested.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  DEFAULT_CHANNEL_TTL,
  ensureChannel,
  parseChannelTtl,
  sanitizeChannelId,
} from '../../../src/deploy/hosting/channels.js';

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

let originalFetch: typeof fetch;
let calls: FetchCall[];

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? 'GET';
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* keep as string */ }
    }
    const call: FetchCall = { url, method, body, headers: (init?.headers as Record<string, string>) ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = originalFetch; });

const channelResource = {
  name: 'projects/12345/sites/site/channels/pr-1',
  url: 'https://site--pr-1-abc123de.web.app',
  expireTime: '2026-06-17T00:00:00Z',
};

describe('ensureChannel', () => {
  test('create pins URL + ttl body per createChannel (api.ts:332-345)', async () => {
    mockFetch(() => new Response(JSON.stringify(channelResource), { status: 200 }));
    const result = await ensureChannel({ siteId: 'site', channelId: 'pr-1', accessToken: 'tok' });
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') throw new Error('unreachable');
    // url + expireTime come from the channel resource — never synthesized.
    expect(result.channel.url).toBe('https://site--pr-1-abc123de.web.app');
    expect(result.channel.expireTime).toBe('2026-06-17T00:00:00Z');
    // REST shape: POST /projects/-/sites/{site}/channels?channelId={id}
    // with body { ttl } — default 7d = '604800s' (DEFAULT_DURATION,
    // expireUtils.ts:32, serialized per api.ts:340).
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe('https://firebasehosting.googleapis.com/v1beta1/projects/-/sites/site/channels?channelId=pr-1');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ ttl: '604800s' });
  });

  test('explicit ttl flows through to the create body', async () => {
    mockFetch(() => new Response(JSON.stringify(channelResource), { status: 200 }));
    await ensureChannel({ siteId: 'site', channelId: 'pr-1', ttl: '3600s', accessToken: 'tok' });
    expect(calls[0]?.body).toEqual({ ttl: '3600s' });
  });

  test('409 → existed; re-reads the channel via getChannel (api.ts:274-290)', async () => {
    mockFetch((call) => call.method === 'POST'
      ? new Response('channel exists', { status: 409 })
      : new Response(JSON.stringify(channelResource), { status: 200 }));
    const result = await ensureChannel({ siteId: 'site', channelId: 'pr-1', accessToken: 'tok' });
    expect(result.kind).toBe('existed');
    if (result.kind !== 'existed') throw new Error('unreachable');
    expect(result.channel.url).toBe('https://site--pr-1-abc123de.web.app');
    // Second call is the GET on the channel resource.
    expect(calls.length).toBe(2);
    expect(calls[1]?.url).toBe('https://firebasehosting.googleapis.com/v1beta1/projects/-/sites/site/channels/pr-1');
    expect(calls[1]?.method).toBe('GET');
  });

  test('400 → invalid_id with upstream message', async () => {
    mockFetch(() => new Response('invalid channel id format', { status: 400 }));
    const result = await ensureChannel({ siteId: 'site', channelId: 'BAD ID', accessToken: 'tok' });
    expect(result.kind).toBe('invalid_id');
    if (result.kind !== 'invalid_id') throw new Error('unreachable');
    expect(result.message).toContain('invalid channel id format');
  });

  test('403 → permission_denied with role hint', async () => {
    mockFetch(() => new Response('forbidden', { status: 403 }));
    const result = await ensureChannel({ siteId: 'site', channelId: 'pr-1', accessToken: 'tok' });
    expect(result.kind).toBe('permission_denied');
    if (result.kind !== 'permission_denied') throw new Error('unreachable');
    expect(result.message).toContain('roles/firebasehosting.admin');
  });

  test('409 then failing GET propagates the GET outcome', async () => {
    mockFetch((call) => call.method === 'POST'
      ? new Response('channel exists', { status: 409 })
      : new Response('boom', { status: 500 }));
    const result = await ensureChannel({ siteId: 'site', channelId: 'pr-1', accessToken: 'tok' });
    expect(result.kind).toBe('http_error');
    if (result.kind !== 'http_error') throw new Error('unreachable');
    expect(result.status).toBe(500);
  });

  test('network failure → network_error', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    const result = await ensureChannel({ siteId: 'site', channelId: 'pr-1', accessToken: 'tok' });
    expect(result.kind).toBe('network_error');
  });
});

describe('sanitizeChannelId', () => {
  test('lowercases and replaces non [a-z0-9-] chars', () => {
    expect(sanitizeChannelId('Feat/Auth_Resolver.P4')).toBe('feat-auth-resolver-p4');
  });

  test('collapses runs of dashes', () => {
    expect(sanitizeChannelId('fix//double--slash')).toBe('fix-double-slash');
  });

  test('strips leading/trailing dashes', () => {
    expect(sanitizeChannelId('--weird-branch--')).toBe('weird-branch');
  });

  test('truncates to 63 chars before stripping the trailing dash', () => {
    const long = 'a'.repeat(62) + '-tail';
    const out = sanitizeChannelId(long);
    expect(out.length).toBeLessThanOrEqual(63);
    expect(out).toBe('a'.repeat(62));
  });

  test('returns empty string when nothing survives', () => {
    expect(sanitizeChannelId('///')).toBe('');
  });
});

describe('parseChannelTtl', () => {
  test('grammar mirrors DURATION_REGEX (expireUtils.ts:7): m/h/d', () => {
    expect(parseChannelTtl('30m')).toEqual({ ok: true, ttl: '1800s' });
    expect(parseChannelTtl('12h')).toEqual({ ok: true, ttl: '43200s' });
    expect(parseChannelTtl('7d')).toEqual({ ok: true, ttl: DEFAULT_CHANNEL_TTL });
  });

  test('rejects malformed durations', () => {
    for (const bad of ['7', 'd7', '1.5d', '7w', '']) {
      const out = parseChannelTtl(bad);
      expect(out.ok).toBe(false);
    }
  });

  test('caps at 30d (MAX_DURATION, expireUtils.ts:27)', () => {
    expect(parseChannelTtl('30d').ok).toBe(true);
    const out = parseChannelTtl('31d');
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.message).toContain('30d');
  });

  test('rejects zero durations', () => {
    expect(parseChannelTtl('0d').ok).toBe(false);
  });
});
