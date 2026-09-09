/**
 * The effect enforcement invariant (ADR-0014 Decision 5).
 *
 * A `destructive` method refuses a call without `args.confirm === true`. A
 * `production` method is listed either way, under a heading that says whether
 * it is disabled, and `describe` answers for it either way; what the opt-in
 * gates is the call, which is refused without `--allow-production` and then
 * refused again without a confirmation. Both the MCP path and the CLI path
 * pass through the same functions this file tests, so there is exactly one
 * place either kind of refusal can drift.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import {
  failFor,
  validateArguments,
  validateDescribe,
} from '../../../src/bridge/surface/method-validation.js';
import { describeTool } from '../../../src/bridge/surface/render/sdk-service.js';
import { renderToolDescription } from '../../../src/bridge/surface/tool-description.js';
import {
  ALLOW_PRODUCTION_ENV_KEY,
  ALLOW_PRODUCTION_FLAG,
  PRODUCTION_DISABLED_HEADING,
  PRODUCTION_ENABLED_HEADING,
  allowProductionFrom,
  refuseUnconfirmedDestructive,
  refuseUnconfirmedProduction,
  refuseUnmountedProduction,
} from '../../../src/bridge/surface/method-effects.js';
import { METHODS, methodByKey, toolByName, TOOLS } from '../../../src/bridge/surface/methods/registry.js';
import type { Method, Tool } from '../../../src/bridge/surface/method-types.js';

/** A method record built only for this test; never filed under `methods/`. */
function fakeMethod(overrides: Partial<Method>): Method {
  return {
    tool: 'sandbox',
    method: 'wipeEverything',
    sdkOrigin: 'pyric',
    effect: 'production',
    signature: 'wipeEverything(confirm)',
    description: 'A method invented only to exercise effect enforcement.',
    args: z.object({ confirm: z.boolean().optional() }),
    operation: 'wipe_everything_for_test',
    example: {},
    async handler() {
      return { ok: true, summary: 'ran', data: {} };
    },
    key: 'sandbox.wipeEverything',
    ...overrides,
  };
}

describe('reading whether production is allowed', () => {
  it('takes the flag over the environment', () => {
    expect(allowProductionFrom(true, {})).toBe(true);
    expect(allowProductionFrom(true, { [ALLOW_PRODUCTION_ENV_KEY]: 'no' })).toBe(true);
  });

  it('takes an exact word from the environment and nothing else truthy', () => {
    expect(allowProductionFrom(false, { [ALLOW_PRODUCTION_ENV_KEY]: '1' })).toBe(true);
    expect(allowProductionFrom(false, { [ALLOW_PRODUCTION_ENV_KEY]: 'true' })).toBe(true);
    expect(allowProductionFrom(false, { [ALLOW_PRODUCTION_ENV_KEY]: 'yes' })).toBe(false);
    expect(allowProductionFrom(false, { [ALLOW_PRODUCTION_ENV_KEY]: 'TRUE' })).toBe(false);
    expect(allowProductionFrom(false, {})).toBe(false);
  });
});

describe('destructive refusal', () => {
  const destructive = fakeMethod({
    effect: 'destructive',
    method: 'discardEverything',
    key: 'sandbox.discardEverything',
    args: z.object({ confirm: z.boolean().optional() }),
  });

  it('refuses a destructive call with no confirm', () => {
    const fail = failFor(destructive.tool, destructive.method);
    const rejection = refuseUnconfirmedDestructive(destructive, {}, fail);
    expect(rejection).not.toBeNull();
    expect(rejection?.data.field).toBe('confirm');
    expect(rejection?.data.tool).toBe('sandbox');
    expect(rejection?.data.method).toBe('discardEverything');
  });

  it('refuses a destructive call with confirm false', () => {
    const fail = failFor(destructive.tool, destructive.method);
    expect(refuseUnconfirmedDestructive(destructive, { confirm: false }, fail)).not.toBeNull();
  });

  it('allows a destructive call with confirm true', () => {
    const fail = failFor(destructive.tool, destructive.method);
    expect(refuseUnconfirmedDestructive(destructive, { confirm: true }, fail)).toBeNull();
  });

  it('does not refuse a non-destructive call regardless of confirm', () => {
    const read = fakeMethod({ effect: 'read', method: 'readOnly', key: 'sandbox.readOnly' });
    const fail = failFor(read.tool, read.method);
    expect(refuseUnconfirmedDestructive(read, {}, fail)).toBeNull();
  });

  it('goes through validateArguments, the one place both the MCP path and the CLI path call', () => {
    const result = validateArguments(destructive, {});
    expect(result).not.toBeNull();
    expect(result?.data.field).toBe('confirm');
    expect(validateArguments(destructive, { confirm: true })).toBeNull();
  });

  it('names every destructive method today', () => {
    const destructiveRecords = METHODS.filter((method) => method.effect === 'destructive');
    expect(destructiveRecords.map((method) => method.key).sort()).toEqual([
      'sandbox.deleteCheckpoint',
      'sandbox.promote',
      'sandbox.reset',
      'sandbox.restore',
    ]);
  });

  it('carries confirm in the signature and the schema of every destructive and production method', () => {
    for (const method of METHODS) {
      if (method.effect !== 'destructive' && method.effect !== 'production') continue;
      expect(method.signature).toContain('confirm');
      expect(Object.keys(method.args.shape)).toContain('confirm');
    }
  });
});

describe('production gating', () => {
  const production = fakeMethod({});

  it('refuses a production call when production is not allowed, in the heading sentence', () => {
    const fail = failFor(production.tool, production.method);
    const rejection = refuseUnmountedProduction(production, false, fail);
    expect(rejection).not.toBeNull();
    expect(rejection?.summary).toContain(ALLOW_PRODUCTION_FLAG);
    expect(rejection?.summary).toContain(PRODUCTION_DISABLED_HEADING);
    expect(rejection?.data.field).toBeUndefined();
    // Not a schema rejection: the arguments were fine and the server was not
    // started for the call, which the evaluation counts as an error rather
    // than as the caller getting the arguments wrong.
    expect(rejection?.data.code).toBe('production_disabled');
  });

  it('stops refusing on the flag alone and refuses on the confirmation instead', () => {
    const fail = failFor(production.tool, production.method);
    expect(refuseUnmountedProduction(production, true, fail)).toBeNull();
    const unconfirmed = refuseUnconfirmedProduction(production, {}, fail);
    expect(unconfirmed?.data.field).toBe('confirm');
    expect(refuseUnconfirmedProduction(production, { confirm: true }, fail)).toBeNull();
  });

  it('does not refuse a non-production call', () => {
    const read = fakeMethod({ effect: 'read', method: 'readOnly', key: 'sandbox.readOnly' });
    const fail = failFor(read.tool, read.method);
    expect(refuseUnmountedProduction(read, false, fail)).toBeNull();
    expect(refuseUnconfirmedProduction(read, {}, fail)).toBeNull();
  });

  it('goes through validateArguments with allowProduction threaded in', () => {
    const refused = validateArguments(production, { confirm: true }, false);
    expect(refused?.summary).toContain(ALLOW_PRODUCTION_FLAG);
    expect(validateArguments(production, {}, true)?.data.field).toBe('confirm');
    expect(validateArguments(production, { confirm: true }, true)).toBeNull();
  });

  /** The two-method tool the description and describe checks are read from. */
  const describedTool: Tool = {
    intro: 'A tool built only for this test.',
    order: 999,
    name: 'sandbox',
    methods: [
      production,
      fakeMethod({
        effect: 'read',
        method: 'readOnly',
        key: 'sandbox.readOnly',
        signature: 'readOnly()',
        args: z.object({}),
      }),
    ],
  };

  it('lists a disabled production method under the heading that names the flag', () => {
    const withheld = renderToolDescription(describedTool, false);
    expect(withheld).toContain('wipeEverything');
    expect(withheld).toContain(PRODUCTION_DISABLED_HEADING);
    const enabled = renderToolDescription(describedTool, true);
    expect(enabled).toContain('wipeEverything');
    expect(enabled).toContain(PRODUCTION_ENABLED_HEADING);
  });

  it('answers describe for a disabled production method, with its effect class', () => {
    expect(validateDescribe(describedTool, { method: 'wipeEverything' })).toBeNull();
  });

  it('names every production method today', () => {
    const productionRecords = METHODS.filter((method) => method.effect === 'production');
    expect(productionRecords.map((method) => method.key)).toEqual(['assurance.testRulesHosted']);
  });

  it("shows the assurance tool's disabled heading on a server that did not opt in", () => {
    const assurance = toolByName('assurance');
    if (assurance === undefined) throw new Error('no assurance tool');
    expect(describeTool(assurance, false)).toContain(PRODUCTION_DISABLED_HEADING);
    expect(describeTool(assurance, false)).toContain('testRulesHosted');
  });

  it('refuses the real production method through the rendered tool and through describe', async () => {
    const surface = renderSurface('sdk-service');
    const tool = surface.tools.find((candidate) => candidate.name === 'assurance');
    if (tool === undefined) throw new Error('no rendered assurance tool');
    const ctx = createSurfaceContext(initializeSandbox(), process.cwd());

    const described = await tool.execute(
      { method: 'describe', args: { method: 'testRulesHosted' } },
      ctx,
    );
    expect(described.ok).toBe(true);
    expect((described.data as { effect: string }).effect).toBe('production');

    const refused = await tool.execute(
      { method: 'testRulesHosted', args: { service: 'firestore', rules: 'x', cases: [{}] } },
      ctx,
    );
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain(ALLOW_PRODUCTION_FLAG);
  });
});

/**
 * Every rendered surface reaches a handler through `validateArguments`, so a
 * destructive call is refused without `confirm` and a `production` call is
 * refused without the flag on all of them alike. The three named surfaces are
 * the `one-tool-per-method` builder under its three word orders, so rendering
 * all three exercises that builder too.
 */
describe('every rendered surface passes through the one validator', () => {
  const ctx = createSurfaceContext(initializeSandbox());

  /** One surface, the tool a reset arrives on, and the arguments both ways. */
  interface ResetCall {
    surface: string;
    tool: string;
    unconfirmed: Record<string, unknown>;
    confirmed: Record<string, unknown>;
  }

  const RESET_CALLS: readonly ResetCall[] = [
    {
      surface: 'sdk-service',
      tool: 'sandbox',
      unconfirmed: { method: 'reset', args: {} },
      confirmed: { method: 'reset', args: { confirm: true } },
    },
    {
      surface: 'verb-prefixed',
      tool: 'reset_sandbox',
      unconfirmed: {},
      confirmed: { confirm: true },
    },
    {
      surface: 'noun-prefixed',
      tool: 'sandbox_reset',
      unconfirmed: {},
      confirmed: { confirm: true },
    },
    {
      surface: 'verb-suffixed',
      tool: 'reset_sandbox',
      unconfirmed: {},
      confirmed: { confirm: true },
    },
    {
      surface: 'discriminator',
      tool: 'control_sandbox_environment',
      unconfirmed: { action: 'reset_all' },
      confirmed: { action: 'reset_all', confirm: true },
    },
  ];

  /** One rendered tool of one surface, or a failure naming what was asked for. */
  function toolOf(surface: string, name: string, options?: { allowProduction?: boolean }) {
    const rendered = renderSurface(surface, options).tools.find((tool) => tool.name === name);
    if (rendered === undefined) throw new Error(`${surface} renders no tool named '${name}'`);
    return rendered;
  }

  for (const call of RESET_CALLS) {
    it(`${call.surface} refuses an unconfirmed reset and runs a confirmed one`, async () => {
      const tool = toolOf(call.surface, call.tool);
      const refused = await tool.execute(call.unconfirmed, ctx);
      expect(refused.ok).toBe(false);
      expect(refused.summary).toContain('confirm: true');
      const confirmed = await tool.execute(call.confirmed, ctx);
      expect(confirmed.ok).toBe(true);
    });
  }

  it('refuses the production method on every surface that renders it', async () => {
    const hosted = { service: 'firestore', rules: 'x', cases: [{}], confirm: true };
    const named = await toolOf('verb-prefixed', 'test_assurance_rules_hosted').execute(hosted, ctx);
    expect(named.summary).toContain(ALLOW_PRODUCTION_FLAG);

    const discriminated = await toolOf('discriminator', 'judge_authorization_risk').execute(
      {
        action: 'test_rules_hosted',
        candidateRules: 'x',
        casesJson: '[{}]',
        confirm: true,
      },
      ctx,
    );
    expect(discriminated.summary).toContain(ALLOW_PRODUCTION_FLAG);
  });

  it('reads the record the key names, which is the same record every surface renders', () => {
    expect(methodByKey('sandbox.reset').effect).toBe('destructive');
    expect(TOOLS.some((tool) => tool.methods.some((method) => method.key === 'sandbox.reset'))).toBe(
      true,
    );
  });
});
