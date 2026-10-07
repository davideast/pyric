/**
 * The Realtime Database rules engine: lint, simulate against either the
 * running ruleset or a supplied one, and install. `compileFailure`'s exact
 * wording is `rules-engines/registry.test.ts`'s subject; this file exercises
 * lint, simulate, and install, which run against a live sandbox.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext } from '../../../../src/bridge/surface/context.js';
import { DATABASE_RULES } from '../../../../src/bridge/surface/rules-engines/database.js';

const OPEN_RULES = JSON.stringify({ rules: { '.read': true, '.write': true } });
/** A public read below the root: a hardcoded-true lint warning and a medium security finding. */
const WARNING_RULES = JSON.stringify({ rules: { scores: { '.read': true } } });
const CLOSED_RULES = JSON.stringify({ rules: { '.read': false, '.write': false } });
const GATE_INSTANT = Date.parse('2026-01-01T00:00:00.000Z');
const NOW_GATED_RULES = JSON.stringify({ rules: { '.read': `now > ${GATE_INSTANT}` } });

/** A rules file as written by hand: line and block comments around and inside the object. */
const OWNER_RULES = `{
  "rules": { "notes": { "$uid": { ".read": "auth != null && auth.uid == $uid", ".write": "auth != null && auth.uid == $uid", ".validate": "newData.isString()" } } }
}`;
const COMMENTED_OWNER_RULES = `/* Notes rules. */
{
  // Each user reads and writes their own notes.
  "rules": {
    "notes": {
      /* One entry per user id. */
      "$uid": {
        ".read": "auth != null && auth.uid == $uid", // the owner only
        ".write": "auth != null && auth.uid == $uid",
        ".validate": "newData.isString()"
      }
    }
  }
}
`;
/** A comment does not make broken JSON parse. */
const COMMENTED_BROKEN_RULES = `{
  // An unterminated object.
  "rules": { "notes": { ".read": true }
`;

function freshContext() {
  return createSurfaceContext(initializeSandbox());
}

describe('requestMethods', () => {
  it('evaluates read, write, and validate', () => {
    expect([...DATABASE_RULES.requestMethods]).toEqual(['read', 'write', 'update', 'validate']);
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
    const result = await DATABASE_RULES.lint(freshContext(), WARNING_RULES);
    expect(result.ok).toBe(true);
    expect(result.data).toHaveProperty('issues');
  });

  it('fails a supplied ruleset whose expression does not parse, reporting the error as a lint finding', async () => {
    const broken = JSON.stringify({ rules: { notes: { $id: { '.write': 'auth != null && (' } } } });
    const result = await DATABASE_RULES.lint(freshContext(), broken);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('1 findings, 1 errors');
    const data = result.data as { code: string; issues: Array<{ code: string; severity: string; path: string }> };
    expect(data.code).toBe('lint_findings');
    expect(data.issues).toEqual([
      expect.objectContaining({ code: 'PARSE_ERROR', severity: 'error', path: '/notes/$id' }),
    ]);
  });

  it('passes a supplied ruleset whose findings are warnings only', async () => {
    const result = await DATABASE_RULES.lint(freshContext(), WARNING_RULES);
    expect(result.ok).toBe(true);
    const issues = (result.data as { issues: Array<{ severity: string }> }).issues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.severity === 'warning')).toBe(true);
  });

  it('fails a ruleset that grants public read and write at the root, naming the security findings', async () => {
    const result = await DATABASE_RULES.lint(freshContext(), OPEN_RULES);
    expect(result.ok).toBe(false);
    const issues = (result.data as { issues: Array<{ code: string; severity: string; path: string; fix?: string }> }).issues;
    expect(issues).toContainEqual(expect.objectContaining({ code: 'RTDB-SEC-1', severity: 'error', path: '/', fix: expect.any(String) }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'RTDB-SEC-2', severity: 'error', path: '/' }));
  });

  it('lints a supplied ruleset with line and block comments as it lints the same ruleset without them', async () => {
    const commented = await DATABASE_RULES.lint(freshContext(), COMMENTED_OWNER_RULES);
    const plain = await DATABASE_RULES.lint(freshContext(), OWNER_RULES);
    expect(commented.ok).toBe(true);
    expect(commented).toEqual(plain);
  });

  it('rejects a supplied source with comments that is still not valid JSON', async () => {
    const result = await DATABASE_RULES.lint(freshContext(), COMMENTED_BROKEN_RULES);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('not valid JSON');
  });

  it('lints the ruleset already installed when none is supplied', async () => {
    const ctx = freshContext();
    await DATABASE_RULES.install(ctx, WARNING_RULES);
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

  it('installs a ruleset with comments, the source check accepting it', async () => {
    expect(DATABASE_RULES.compileFailure(COMMENTED_OWNER_RULES)).toBeNull();
    expect(DATABASE_RULES.compileFailure(COMMENTED_BROKEN_RULES)).not.toBeNull();
    const ctx = freshContext();
    const result = await DATABASE_RULES.install(ctx, COMMENTED_OWNER_RULES);
    expect(result.ok).toBe(true);
    const owner = await DATABASE_RULES.simulate(ctx, { operation: 'read', path: 'notes/alice', uid: 'alice' });
    expect((owner.data as { decision: string }).decision).toBe('ALLOW');
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

  it('evaluates a supplied ruleset with line and block comments as it evaluates the same ruleset without them', async () => {
    for (const [uid, decision] of [['alice', 'ALLOW'], ['bob', 'DENY']] as const) {
      const request = { operation: 'read', path: 'notes/alice', uid } as const;
      const commented = await DATABASE_RULES.simulate(freshContext(), { ...request, rules: COMMENTED_OWNER_RULES });
      const plain = await DATABASE_RULES.simulate(freshContext(), { ...request, rules: OWNER_RULES });
      expect((commented.data as { decision: string }).decision).toBe(decision);
      expect(commented).toEqual(plain);
    }
  });

  it('rejects a supplied source with comments that is still not valid JSON', async () => {
    const result = await DATABASE_RULES.simulate(freshContext(), {
      operation: 'read',
      path: 'notes/alice',
      rules: COMMENTED_BROKEN_RULES,
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
