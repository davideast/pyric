/**
 * The Realtime Database rules engine: lint, simulate against either the
 * running ruleset or a supplied one, and install. `parseFailure`'s exact
 * wording is `rules-engines/registry.test.ts`'s subject; this file exercises
 * lint, simulate, and install, which run against a live sandbox.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext } from '../../../../src/bridge/surface/context.js';
import { DATABASE_RULES } from '../../../../src/bridge/surface/rules-engines/database.js';

const OPEN_RULES = JSON.stringify({ rules: { '.read': true, '.write': true } });
const CLOSED_RULES = JSON.stringify({ rules: { '.read': false, '.write': false } });
const GATE_INSTANT = Date.parse('2026-01-01T00:00:00.000Z');
const NOW_GATED_RULES = JSON.stringify({ rules: { '.read': `now > ${GATE_INSTANT}` } });

function freshContext() {
  return createSurfaceContext(initializeSandbox());
}

describe('requestMethods', () => {
  it('evaluates read, write, and validate', () => {
    expect([...DATABASE_RULES.requestMethods]).toEqual(['read', 'write', 'validate']);
  });
});

describe('lint', () => {
  it('fails when no rules are supplied and none are loaded', async () => {
    const result = await DATABASE_RULES.lint(freshContext(), undefined);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('No database rules');
  });

  it('rejects a supplied source that is not valid JSON', async () => {
    const result = await DATABASE_RULES.lint(freshContext(), 'not json');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('not valid JSON');
  });

  it('lints a supplied ruleset, reporting findings and errors', async () => {
    const result = await DATABASE_RULES.lint(freshContext(), OPEN_RULES);
    expect(result.ok).toBe(true);
    expect(result.data).toHaveProperty('issues');
  });

  it('lints the ruleset already installed when none is supplied', async () => {
    const ctx = freshContext();
    await DATABASE_RULES.install(ctx, OPEN_RULES);
    const result = await DATABASE_RULES.lint(ctx, undefined);
    expect(result.ok).toBe(true);
  });
});

describe('install', () => {
  it('rejects a source that does not parse as JSON', async () => {
    const result = await DATABASE_RULES.install(freshContext(), 'not json');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('did not parse');
  });

  it('installs a parsed ruleset', async () => {
    const result = await DATABASE_RULES.install(freshContext(), OPEN_RULES);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Database rules installed.');
  });
});

describe('simulate', () => {
  it('rejects a supplied source that is not valid JSON', async () => {
    const result = await DATABASE_RULES.simulate(freshContext(), {
      operation: 'read',
      path: 'rooms/lobby',
      rules: 'not json',
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('not valid JSON');
  });

  it('evaluates a supplied ruleset against the sandbox tree without installing it', async () => {
    const ctx = freshContext();
    const denied = await DATABASE_RULES.simulate(ctx, {
      operation: 'read',
      path: 'rooms/lobby',
      rules: CLOSED_RULES,
    });
    expect((denied.data as { decision: string }).decision).toBe('DENY');
    expect((denied.data as { allowed: boolean }).allowed).toBe(false);

    const stillOpen = await DATABASE_RULES.lint(ctx, undefined);
    expect(stillOpen.summary).toContain('No database rules');
  });

  it('evaluates against the running ruleset when none is supplied', async () => {
    const ctx = freshContext();
    await DATABASE_RULES.install(ctx, OPEN_RULES);
    const allowed = await DATABASE_RULES.simulate(ctx, {
      operation: 'read',
      path: 'rooms/lobby',
    });
    expect(allowed.ok).toBe(true);
  });

  it('evaluates now-gated rules by an explicit requestTime, against the running ruleset', async () => {
    const ctx = freshContext();
    await DATABASE_RULES.install(ctx, NOW_GATED_RULES);
    const before = await DATABASE_RULES.simulate(ctx, {
      operation: 'read',
      path: 'rooms/lobby',
      requestTime: new Date(GATE_INSTANT - 1000).toISOString(),
    });
    expect((before.data as { decision: string }).decision).toBe('DENY');
    const after = await DATABASE_RULES.simulate(ctx, {
      operation: 'read',
      path: 'rooms/lobby',
      requestTime: new Date(GATE_INSTANT + 1000).toISOString(),
    });
    expect((after.data as { decision: string }).decision).toBe('ALLOW');
  });

  it('evaluates now-gated rules by an explicit requestTime, against a supplied ruleset', async () => {
    const ctx = freshContext();
    const before = await DATABASE_RULES.simulate(ctx, {
      operation: 'read',
      path: 'rooms/lobby',
      rules: NOW_GATED_RULES,
      requestTime: new Date(GATE_INSTANT - 1000).toISOString(),
    });
    expect((before.data as { decision: string }).decision).toBe('DENY');
    const after = await DATABASE_RULES.simulate(ctx, {
      operation: 'read',
      path: 'rooms/lobby',
      rules: NOW_GATED_RULES,
      requestTime: new Date(GATE_INSTANT + 1000).toISOString(),
    });
    expect((after.data as { decision: string }).decision).toBe('ALLOW');
  });

  it('defaults now to the sandbox clock when requestTime is omitted', async () => {
    const ctx = freshContext();
    await DATABASE_RULES.install(ctx, NOW_GATED_RULES);
    getClock(ctx.sandbox).set(GATE_INSTANT - 1000);
    const before = await DATABASE_RULES.simulate(ctx, { operation: 'read', path: 'rooms/lobby' });
    expect((before.data as { decision: string }).decision).toBe('DENY');
    getClock(ctx.sandbox).set(GATE_INSTANT + 1000);
    const after = await DATABASE_RULES.simulate(ctx, { operation: 'read', path: 'rooms/lobby' });
    expect((after.data as { decision: string }).decision).toBe('ALLOW');
  });
});
