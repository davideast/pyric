/**
 * The rtdb-climb probes' calls to `/.settings/rules.json`, against an
 * in-memory rules endpoint. A 429 is waited out with back-off instead of
 * failing the probe, and the refusals probe records only a 400 as a refusal.
 * Nothing reaches the network: every call goes through the fake.
 */
import { describe, expect, it } from 'bun:test';
import { climbRulesEndpoint } from '../../../../src/capture/rtdb-climb/rules-endpoint.ts';
import type { RtdbClimbContext } from '../../../../src/capture/rtdb-climb/probe-types.ts';
import { createProbe as listenerCancellation } from '../../../../src/capture/rtdb-climb/listener-cancellation.probe.ts';
import { createProbe as queryIndexEnforcement } from '../../../../src/capture/rtdb-climb/query-index-enforcement.probe.ts';
import { createProbe as rulesDeployRefusals } from '../../../../src/capture/rtdb-climb/rules-deploy-refusals.probe.ts';
import { RULES_DEPLOY_REFUSAL_CASES } from '../../../../src/capture/rtdb-climb/rules-deploy-refusals.cases.ts';

const DATABASE_URL = 'https://climb-test.firebaseio.com';
const RULES_PATH = '/.settings/rules.json';
const BEFORE = { rules: { '.read': false, pyric_oracle: { '.read': 'auth != null' } } };

interface FakeRules {
  ctx: RtdbClimbContext;
  waits: number[];
  calls: string[];
  live: () => unknown;
}

/**
 * An in-memory rules endpoint. `answer` picks the response for each call; it
 * returns undefined to fall through to a plain store (GET reads, PUT replaces).
 */
function fakeRules(answer: (method: string, body: string, index: number) => Response | undefined = () => undefined): FakeRules {
  let live: unknown = structuredClone(BEFORE);
  const waits: number[] = [];
  const calls: string[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const parsed = new URL(url);
    calls.push(`${method} ${parsed.pathname}`);
    if (parsed.pathname !== RULES_PATH) throw new Error(`unexpected call to ${url}`);
    const body = typeof init?.body === 'string' ? init.body : '';
    const forced = answer(method, body, calls.length);
    if (forced) return forced;
    if (method === 'PUT') {
      live = JSON.parse(body);
      return new Response(null, { status: 200 });
    }
    return Response.json(live);
  };
  const ctx: RtdbClimbContext = {
    config: { projectId: 'climb-test', databaseURL: DATABASE_URL },
    rtdbAdminToken: 'admin-token',
    runId: 'run-1',
    rulesRateLimitDeps: {
      fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
      now: () => 0,
      log: () => {},
    },
  };
  return { ctx, waits, calls, live: () => live };
}

const throttled = () => new Response('{"error":"Request rate limit exceeded"}', { status: 429 });
const isCasePut = (method: string, body: string) => method === 'PUT' && body.includes('rules-deploy-refusals');

describe('rtdb-climb rules endpoint', () => {
  it('waits out a 429 on a rules read and returns the rules', async () => {
    const fake = fakeRules((method, _body, index) => (method === 'GET' && index === 1 ? throttled() : undefined));
    expect(await climbRulesEndpoint(fake.ctx, 'probe').read()).toEqual(BEFORE);
    expect(fake.waits).toEqual([5_000]);
  });

  it('waits out 429s on a rules write and then writes', async () => {
    const fake = fakeRules((method, _body, index) => (method === 'PUT' && index <= 2 ? throttled() : undefined));
    await climbRulesEndpoint(fake.ctx, 'probe').write({ rules: { changed: true } });
    expect(fake.waits).toEqual([5_000, 10_000]);
    expect(fake.live()).toEqual({ rules: { changed: true } });
  });

  it('throws a non-429 failure with the probe label', async () => {
    const fake = fakeRules(() => new Response('nope', { status: 403 }));
    await expect(climbRulesEndpoint(fake.ctx, 'query index').read()).rejects.toThrow('query index rules read failed: 403');
  });
});

describe('rtdb-climb probes back off on a throttled rules read', () => {
  // These probes create Firebase clients right after their first rules read,
  // so the fake ends the run there: it answers 429, then a body that is not
  // JSON. The probe gets past the 429 and fails on the body.
  const probes = { 'listener-cancellation': listenerCancellation, 'query-index-enforcement': queryIndexEnforcement };
  for (const [name, createProbe] of Object.entries(probes)) {
    it(`${name} retries its first rules read after a 429`, async () => {
      const fake = fakeRules((method, _body, index) => {
        if (index === 1) return throttled();
        return method === 'GET' ? new Response('not json', { status: 200 }) : undefined;
      });
      await expect(createProbe(fake.ctx).observe()).rejects.toBeInstanceOf(SyntaxError);
      expect(fake.waits).toEqual([5_000]);
      expect(fake.calls).toEqual([`GET ${RULES_PATH}`, `GET ${RULES_PATH}`]);
    });
  }
});

describe('rtdb-rules-deploy-refusals probe', () => {
  const refusal = () => Response.json({ error: '1:42: refused' }, { status: 400 });

  it('waits out a 429 on a case deploy and records the refusal production then gives', async () => {
    let throttledOnce = false;
    const fake = fakeRules((method, body) => {
      if (!isCasePut(method, body)) return undefined;
      if (!throttledOnce) {
        throttledOnce = true;
        return throttled();
      }
      return refusal();
    });
    const result = await rulesDeployRefusals(fake.ctx).observe();
    const outcomes = Object.values(result.outcomes as Record<string, { accepted: boolean; status: number; message: string }>);
    expect(outcomes).toHaveLength(Object.keys(RULES_DEPLOY_REFUSAL_CASES).length);
    expect(outcomes.every((o) => !o.accepted && o.status === 400 && o.message === 'refused')).toBe(true);
    expect(fake.waits).toEqual([5_000]);
    expect(fake.live()).toEqual(BEFORE);
  });

  it('throws on a status that is neither acceptance nor a 400 refusal, and still restores the rules', async () => {
    const fake = fakeRules((method, body) => (isCasePut(method, body) ? new Response('internal', { status: 500 }) : undefined));
    await expect(rulesDeployRefusals(fake.ctx).observe()).rejects.toThrow(/returned 500/);
    expect(fake.live()).toEqual(BEFORE);
  });

  it('throws on a 429 that outlasts the back-off cap instead of recording it as a refusal', async () => {
    const fake = fakeRules((method, body) => (isCasePut(method, body) ? throttled() : undefined));
    await expect(rulesDeployRefusals(fake.ctx).observe()).rejects.toThrow(/returned 429/);
    expect(fake.live()).toEqual(BEFORE);
  });
});
