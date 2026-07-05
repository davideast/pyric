import { describe, it, expect } from 'bun:test';
import { ensureApisEnabled } from '../../src/deploy/api-enablement.js';
import type { ProjectScope } from '../../src/deploy/scope.js';

const scope: ProjectScope = { projectId: 'demo', resolveToken: async () => 'tok' };

function sink() {
  const o = { text: '', write(s: string) { o.text += s; } };
  return o;
}

interface Canned {
  status?: number;
  json?: unknown;
  text?: string;
}

/** Route Service Usage calls by URL; record the calls for assertions. */
function mockFetch(handler: (url: string, init: RequestInit | undefined) => Canned) {
  const calls: { url: string; method: string }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    const c = handler(url, init);
    const status = c.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return c.json ?? {}; },
      async text() { return c.text ?? JSON.stringify(c.json ?? {}); },
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const noSleep = async () => {};
const now = () => 0;

describe('ensureApisEnabled', () => {
  it('no-ops on an empty API list (no network)', async () => {
    const { fn, calls } = mockFetch(() => ({}));
    const out = sink(), err = sink();
    const r = await ensureApisEnabled({ scope, apis: [], out, err, fetchImpl: fn, sleep: noSleep, now });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('no-ops when all required APIs are already enabled', async () => {
    const { fn, calls } = mockFetch((url) =>
      url.includes('/services/') ? { json: { state: 'ENABLED' } } : { status: 500 },
    );
    const out = sink(), err = sink();
    const r = await ensureApisEnabled({ scope, apis: ['a.com', 'b.com'], out, err, fetchImpl: fn, sleep: noSleep, now });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.url.includes(':batchEnable'))).toBe(false);
  });

  it('enables only the disabled APIs (operation done immediately)', async () => {
    const { fn, calls } = mockFetch((url) => {
      if (url.includes(':batchEnable')) return { json: { done: true } };
      if (url.includes('/services/')) return { json: { state: url.includes('off.com') ? 'DISABLED' : 'ENABLED' } };
      return { status: 500 };
    });
    const out = sink(), err = sink();
    const r = await ensureApisEnabled({ scope, apis: ['on.com', 'off.com'], out, err, fetchImpl: fn, sleep: noSleep, now });
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.url.includes(':batchEnable'))).toBeDefined();
    expect(out.text).toContain('off.com');
    expect(out.text).not.toContain('on.com');
  });

  it('polls a pending operation until it reports done', async () => {
    let polls = 0;
    const { fn } = mockFetch((url) => {
      if (url.includes(':batchEnable')) return { json: { name: 'operations/x' } };
      if (url.includes('/operations/')) { polls++; return { json: polls >= 2 ? { done: true } : {} }; }
      if (url.includes('/services/')) return { json: { state: 'DISABLED' } };
      return { status: 500 };
    });
    const out = sink(), err = sink();
    const r = await ensureApisEnabled({ scope, apis: ['x.com'], out, err, fetchImpl: fn, sleep: noSleep, now });
    expect(r.ok).toBe(true);
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it('prompts with a console link when the caller cannot enable (403)', async () => {
    const { fn } = mockFetch((url) => {
      if (url.includes(':batchEnable')) return { status: 403, text: 'denied' };
      if (url.includes('/services/')) return { json: { state: 'DISABLED' } };
      return { status: 500 };
    });
    const out = sink(), err = sink();
    const r = await ensureApisEnabled({ scope, apis: ['firebase.googleapis.com'], out, err, fetchImpl: fn, sleep: noSleep, now });
    expect(r.ok).toBe(false);
    expect(r.exit).toBe(1);
    expect(err.text).toContain('console.developers.google.com');
    expect(err.text).toContain('firebase.googleapis.com');
    expect(err.text).toContain('serviceUsageAdmin');
  });

  it('fails (exit 2) when the enable operation reports an error', async () => {
    const { fn } = mockFetch((url) => {
      if (url.includes(':batchEnable')) return { json: { done: true, error: { message: 'boom' } } };
      if (url.includes('/services/')) return { json: { state: 'DISABLED' } };
      return { status: 500 };
    });
    const out = sink(), err = sink();
    const r = await ensureApisEnabled({ scope, apis: ['x.com'], out, err, fetchImpl: fn, sleep: noSleep, now });
    expect(r.ok).toBe(false);
    expect(r.exit).toBe(2);
    expect(err.text).toContain('boom');
  });
});
