/**
 * The effect enforcement invariant (ADR-0014 Decision 5): a `destructive`
 * method refuses a call without `args.confirm === true`, and a `production`
 * method is neither callable nor listed unless the server was started with
 * `--allow-production`. Both the MCP path and the CLI path pass through the
 * same functions this file tests, so there is exactly one place either kind
 * of refusal can drift.
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
import {
  mountedMethods,
  mountedTool,
  refuseUnconfirmedDestructive,
  refuseUnmountedProduction,
} from '../../../src/bridge/surface/method-effects.js';
import { METHODS, methodByKey, TOOLS } from '../../../src/bridge/surface/methods/index.js';
import type { Method, Tool } from '../../../src/bridge/surface/method-types.js';

/** A method record built only for this test; never filed under `methods/`. */
function fakeMethod(overrides: Partial<Method>): Method {
  return {
    tool: 'sandbox',
    method: 'wipeEverything',
    sdkOrigin: 'pyric',
    effect: 'production',
    signature: 'wipeEverything()',
    description: 'A method invented only to exercise effect enforcement.',
    args: z.object({}),
    operation: 'wipe_everything_for_test',
    example: {},
    async handler() {
      return { ok: true, summary: 'ran', data: {} };
    },
    key: 'sandbox.wipeEverything',
    ...overrides,
  };
}

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
    const rejection = refuseUnconfirmedDestructive(destructive, { confirm: false }, fail);
    expect(rejection).not.toBeNull();
  });

  it('allows a destructive call with confirm true', () => {
    const fail = failFor(destructive.tool, destructive.method);
    const rejection = refuseUnconfirmedDestructive(destructive, { confirm: true }, fail);
    expect(rejection).toBeNull();
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
    const withConfirm = validateArguments(destructive, { confirm: true });
    expect(withConfirm).toBeNull();
  });

  it('names every destructive method today', () => {
    const destructiveRecords = METHODS.filter((method) => method.effect === 'destructive');
    expect(destructiveRecords.map((method) => method.key)).toEqual(['sandbox.reset']);
  });

  it('carries confirm in the signature and the argument schema of every destructive method', () => {
    for (const method of METHODS) {
      if (method.effect !== 'destructive') continue;
      expect(method.signature).toContain('confirm');
      expect(Object.keys(method.args.shape)).toContain('confirm');
    }
  });
});

describe('production gating', () => {
  const production = fakeMethod({});

  it('refuses a production call when production is not allowed', () => {
    const fail = failFor(production.tool, production.method);
    const rejection = refuseUnmountedProduction(production, false, fail);
    expect(rejection).not.toBeNull();
    expect(rejection?.summary).toContain('--allow-production');
    expect(rejection?.data.field).toBeUndefined();
  });

  it('allows a production call when production is allowed', () => {
    const fail = failFor(production.tool, production.method);
    expect(refuseUnmountedProduction(production, true, fail)).toBeNull();
  });

  it('does not refuse a non-production call', () => {
    const read = fakeMethod({ effect: 'read', method: 'readOnly', key: 'sandbox.readOnly' });
    const fail = failFor(read.tool, read.method);
    expect(refuseUnmountedProduction(read, false, fail)).toBeNull();
  });

  it('goes through validateArguments with allowProduction threaded in', () => {
    const refused = validateArguments(production, {}, false);
    expect(refused).not.toBeNull();
    expect(refused?.summary).toContain('--allow-production');
    const allowed = validateArguments(production, {}, true);
    expect(allowed).toBeNull();
  });

  it('mountedMethods drops production methods unless allowed', () => {
    const methods = [production, fakeMethod({ effect: 'read', method: 'readOnly', key: 'sandbox.readOnly' })];
    expect(mountedMethods(methods, false).map((m) => m.method)).toEqual(['readOnly']);
    expect(mountedMethods(methods, true).map((m) => m.method)).toEqual([
      'wipeEverything',
      'readOnly',
    ]);
  });

  it('mountedTool filters a tool down to its mounted methods only', () => {
    const tool: Tool = {
      intro: 'A tool built only for this test.',
      order: 999,
      name: 'sandbox',
      methods: [production, fakeMethod({ effect: 'read', method: 'readOnly', key: 'sandbox.readOnly' })],
    };
    const withoutProduction = mountedTool(tool, false);
    expect(withoutProduction.methods.map((m) => m.method)).toEqual(['readOnly']);
    const withProduction = mountedTool(tool, true);
    expect(withProduction.methods.map((m) => m.method)).toEqual(['wipeEverything', 'readOnly']);
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
      }),
    ],
  };

  it('keeps an unmounted production method out of the description a client reads', () => {
    const tool = describedTool;
    const withheld = describeTool(mountedTool(tool, false));
    expect(withheld).not.toContain('wipeEverything');
    expect(withheld).toContain('readOnly');
    expect(describeTool(mountedTool(tool, true))).toContain('wipeEverything');
  });

  it('refuses describe for an unmounted production method', () => {
    const tool = describedTool;
    const rejection = validateDescribe(mountedTool(tool, false), { method: 'wipeEverything' });
    expect(rejection).not.toBeNull();
    expect(rejection?.data.field).toBe('method');
    expect(validateDescribe(mountedTool(tool, true), { method: 'wipeEverything' })).toBeNull();
  });

  it('today no real tool carries a production method, so every mounted tool equals its source', () => {
    for (const tool of TOOLS) {
      expect(mountedTool(tool, false).methods.length).toBe(tool.methods.length);
    }
  });
});

/**
 * Every rendered surface reaches a handler through `validateArguments`, so a
 * destructive call is refused without `confirm` and a `production` method is
 * unreachable on all of them alike. The three named surfaces are the
 * `one-tool-per-method` builder under its three word orders, so rendering all
 * three exercises that builder too.
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
    it(`${call.surface} refuses a reset with no confirm and runs one that confirms`, async () => {
      const tool = toolOf(call.surface, call.tool);
      const refused = await tool.execute(call.unconfirmed, ctx);
      expect(refused.ok).toBe(false);
      expect(refused.summary).toContain('confirm: true');

      const ran = await tool.execute(call.confirmed, ctx);
      expect(ran.ok).toBe(true);
    });
  }

  /**
   * Reclassify one loaded record as `production` for the duration of a check.
   * No `production` record ships yet, so reclassifying a record every surface
   * already carries is the only way to exercise the gate through a rendering.
   */
  async function asProduction(key: string, run: () => Promise<void>): Promise<void> {
    const method = methodByKey(key);
    const held = method.effect;
    method.effect = 'production';
    try {
      await run();
    } finally {
      method.effect = held;
    }
  }

  /** The tool a reclassified `sandbox.inspect` would be rendered as, per surface. */
  const INSPECT_TOOLS: ReadonlyArray<[string, string]> = [
    ['verb-prefixed', 'inspect_sandbox'],
    ['noun-prefixed', 'sandbox_inspect'],
    ['verb-suffixed', 'inspect_sandbox'],
  ];

  for (const [surface, tool] of INSPECT_TOOLS) {
    it(`${surface} renders no tool for a production method unless production is allowed`, async () => {
      await asProduction('sandbox.inspect', async () => {
        const withheld = renderSurface(surface, { allowProduction: false }).tools;
        expect(withheld.map((rendered) => rendered.name)).not.toContain(tool);
        const mounted = renderSurface(surface, { allowProduction: true }).tools;
        expect(mounted.map((rendered) => rendered.name)).toContain(tool);
      });
    });
  }

  it('sdk-service withholds a production method from its enum and refuses the call', async () => {
    await asProduction('sandbox.inspect', async () => {
      const sandbox = toolOf('sdk-service', 'sandbox', { allowProduction: false });
      const schema = sandbox.inputSchema.properties as { method: { enum: string[] } };
      expect(schema.method.enum).not.toContain('inspect');
      const refused = await sandbox.execute({ method: 'inspect', args: {} }, ctx);
      expect(refused.ok).toBe(false);
      expect(refused.summary).toContain('no method');
    });
  });

  it('refuses to render a service tool whose every method is withheld', async () => {
    await asProduction('sandbox.inspect', async () => {
      await asProduction('sandbox.seed', async () => {
        await asProduction('sandbox.reset', async () => {
          expect(() => renderSurface('sdk-service')).toThrow(/sandbox/);
          expect(() => renderSurface('sdk-service', { allowProduction: true })).not.toThrow();
        });
      });
    });
  });

  it('discriminator refuses a production method behind a resource read', async () => {
    await asProduction('sandbox.inspect', async () => {
      const resources = renderSurface('discriminator').resources ?? [];
      const status = resources.find((resource) => resource.name === 'sandbox_status');
      if (status === undefined) throw new Error('the discriminator renders no sandbox_status');
      const refused = await status.read('pyric://sandbox/status', ctx);
      expect(refused.ok).toBe(false);
      expect(refused.summary).toContain('--allow-production');
    });
  });
});
