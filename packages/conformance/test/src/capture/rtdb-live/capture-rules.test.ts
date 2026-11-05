/**
 * The live captures' cleanup restores the prior rules even when removing the
 * run path fails, and reports the failure as an invariant, not a throw. The
 * admin REST calls are a fake; nothing reaches the network.
 */
import { describe, expect, test } from 'bun:test';
import { runWithCaptureRules, type AdminRest } from '../../../../src/capture/rtdb-live/live-capture.ts';

const PRIOR_RULES = '{\n  "rules": {\n    ".read": false,\n    ".write": false\n  }\n}';
const RUN = { runId: 'run-1', runPath: 'pyric-live-capture/run-1' };

interface Call { method: string; path: string; body?: string; query?: string }

/** A fake instance: rules and run-path data in memory; `failDelete` makes DELETE reject or answer 500. */
function fakeRest(failDelete: 'reject' | 'status' | 'none'): { rest: AdminRest; calls: Call[]; rules: () => string } {
  let rules = PRIOR_RULES;
  let data = 'null';
  const calls: Call[] = [];
  const rest: AdminRest = {
    async request(method, path, body, query) {
      calls.push({ method, path, body, query });
      if (path === '.settings/rules') {
        if (method === 'GET') return { status: 200, text: rules };
        if (query === '?dryRun=true') return { status: 200, text: '{"status":"ok"}' };
        rules = body!;
        return { status: 200, text: '{"status":"ok"}' };
      }
      if (method === 'DELETE') {
        if (failDelete === 'reject') throw new Error('token fetch failed');
        if (failDelete === 'status') return { status: 500, text: 'error' };
        data = 'null';
        return { status: 200, text: 'null' };
      }
      if (method === 'GET') return { status: 200, text: data };
      data = body ?? 'null';
      return { status: 200, text: data };
    },
  };
  return { rest, calls, rules: () => rules };
}

describe('runWithCaptureRules cleanup', () => {
  test('restores the exact prior rules when the DELETE rejects', async () => {
    const fake = fakeRest('reject');
    const run = await runWithCaptureRules('fake', fake.rest, RUN, async () => 'done');
    expect(run.result).toBe('done');
    expect(run.invariants).toEqual({ dataRemoved: false, rulesRestored: true });
    expect(fake.rules()).toBe(PRIOR_RULES);
    const restore = fake.calls.findLast((c) => c.method === 'PUT' && c.path === '.settings/rules');
    expect(restore?.body).toBe(PRIOR_RULES);
  });

  test('restores the rules when the DELETE answers an error status', async () => {
    const fake = fakeRest('status');
    const run = await runWithCaptureRules('fake', fake.rest, RUN, async () => 'done');
    expect(run.invariants).toEqual({ dataRemoved: false, rulesRestored: true });
    expect(fake.rules()).toBe(PRIOR_RULES);
  });

  test('restores the rules and keeps the body error when the body throws', async () => {
    const fake = fakeRest('none');
    const run = await runWithCaptureRules('fake', fake.rest, RUN, async () => { throw new Error('sequence failed'); });
    expect(run.error?.message).toBe('sequence failed');
    expect(run.invariants).toEqual({ dataRemoved: true, rulesRestored: true });
    expect(fake.rules()).toBe(PRIOR_RULES);
  });

  test('shuts the clients down before the DELETE, and a failed shutdown still cleans up', async () => {
    const fake = fakeRest('none');
    const order: string[] = [];
    const run = await runWithCaptureRules('fake', fake.rest, RUN, async () => {
      order.push('body');
    }, {
      shutdown: async () => {
        order.push(`shutdown after ${fake.calls.filter((c) => c.method === 'DELETE').length} deletes`);
        throw new Error('goOffline failed');
      },
    });
    expect(order).toEqual(['body', 'shutdown after 0 deletes']);
    expect(run.invariants).toEqual({ dataRemoved: true, rulesRestored: true });
  });
});
