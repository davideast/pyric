/**
 * `callMethod`, the one entry every rendered surface reaches a record
 * through: it validates the arguments first and only runs the handler when
 * validation passes, so a rejection never reaches the handler and a valid
 * call never runs unvalidated.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext } from '../../../src/bridge/surface/context.js';
import { callMethod } from '../../../src/bridge/surface/method-call.js';
import type { Method } from '../../../src/bridge/surface/method-types.js';

/** A method record built only for this test; never filed under `methods/`. */
function fakeMethod(overrides: Partial<Method> = {}): Method {
  return {
    tool: 'sandbox',
    method: 'echo',
    sdkOrigin: 'pyric',
    effect: 'read',
    signature: 'echo(value)',
    description: 'A method invented only to exercise callMethod.',
    args: z.object({ value: z.string() }),
    operation: 'echo_value_for_test',
    example: { value: 'hi' },
    async handler(args) {
      return { ok: true, summary: `echoed ${String(args.value)}`, data: null };
    },
    key: 'sandbox.echo',
    ...overrides,
  };
}

const ctx = createSurfaceContext(initializeSandbox());

describe('callMethod', () => {
  it('runs the handler and returns its result when arguments are valid', async () => {
    const result = await callMethod(fakeMethod(), { value: 'hi' }, ctx);
    expect(result).toEqual({ ok: true, summary: 'echoed hi', data: null });
  });

  it('returns the rejection instead of running the handler when arguments are invalid', async () => {
    let ran = false;
    const method = fakeMethod({
      async handler() {
        ran = true;
        return { ok: true, summary: 'should not run' };
      },
    });
    const result = await callMethod(method, { value: 1 }, ctx);
    expect(result.ok).toBe(false);
    expect(ran).toBe(false);
  });

  it('refuses a production method unless allowProduction is passed true', async () => {
    const production = fakeMethod({
      effect: 'production',
      args: z.object({ value: z.string(), confirm: z.boolean().optional() }),
    });
    const refused = await callMethod(production, { value: 'hi' }, ctx);
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('--allow-production');

    // Allowed, the call still confirms: the flag opts the session in and the
    // confirmation opts this one call in.
    const unconfirmed = await callMethod(production, { value: 'hi' }, ctx, true);
    expect(unconfirmed.ok).toBe(false);
    expect(unconfirmed.summary).toContain('confirm: true');

    const allowed = await callMethod(production, { value: 'hi', confirm: true }, ctx, true);
    expect(allowed.ok).toBe(true);
  });

  it('defaults allowProduction to false without the caller naming it', async () => {
    const production = fakeMethod({ effect: 'production', method: 'echo2', key: 'sandbox.echo2' });
    const refused = await callMethod(production, { value: 'hi' }, ctx);
    expect(refused.ok).toBe(false);
  });

  it('names the trace call on a result Security Rules refused', async () => {
    const denied = fakeMethod({
      tool: 'firestore',
      method: 'getDoc',
      key: 'firestore.getDoc',
      async handler() {
        return { ok: false, summary: 'get orders/o2 denied by rules' };
      },
    });
    const result = await callMethod(denied, { value: 'hi' }, ctx);
    expect(result.summary).toContain(
      "Call rules.explainDenial with service 'firestore' for the trace.",
    );
    expect((result.data as { code: string }).code).toBe('denied_by_rules');
  });
});
