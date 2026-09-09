/**
 * The effect enforcement invariant (ADR-0014 Decision 5): a `destructive`
 * method refuses a call without `args.confirm === true`, and a `production`
 * method is neither callable nor listed unless the server was started with
 * `--allow-production`. Both the MCP path and the CLI path pass through the
 * same functions this file tests, so there is exactly one place either kind
 * of refusal can drift.
 */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { failFor, validateArguments } from '../../../src/bridge/surface/method-validation.js';
import {
  mountedMethods,
  mountedTool,
  refuseUnconfirmedDestructive,
  refuseUnmountedProduction,
} from '../../../src/bridge/surface/method-effects.js';
import { METHODS, TOOLS } from '../../../src/bridge/surface/methods/index.js';
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

  it('today no real tool carries a production method, so every mounted tool equals its source', () => {
    for (const tool of TOOLS) {
      expect(mountedTool(tool, false).methods.length).toBe(tool.methods.length);
    }
  });
});
