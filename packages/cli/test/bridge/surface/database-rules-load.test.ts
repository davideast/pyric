import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getActiveRules } from 'pyric/sandbox/database';

import { createSurfaceContext } from '../../../src/bridge/surface/context.js';
import { databaseRulesSource, installDatabaseRules, loadDatabaseRules } from '../../../src/bridge/surface/database-rules-load.js';
import { DATABASE_RULES } from '../../../src/bridge/surface/rules-engines/database.js';

const OPEN = { rules: { '.read': true, '.write': true } };
const REFUSED = { rules: { rooms: { '.write': "auth.uid = 'x'" } } };

describe('installDatabaseRules', () => {
  it('installs rules production would load', () => {
    const sandbox = initializeSandbox();
    expect(installDatabaseRules(sandbox, OPEN)).toBeNull();
    expect(getActiveRules(sandbox)).toEqual(OPEN);
  });

  it('keeps the rules in force and returns the rejection when production would refuse', () => {
    const sandbox = initializeSandbox();
    installDatabaseRules(sandbox, OPEN);
    const rejection = installDatabaseRules(sandbox, REFUSED);
    expect(rejection?.kind).toBe('compile');
    expect(getActiveRules(sandbox)).toEqual(OPEN);
  });
});

describe('databaseRulesSource', () => {
  it('reads the refused ruleset while the rules in force at the refusal still are', () => {
    const sandbox = initializeSandbox();
    installDatabaseRules(sandbox, OPEN);
    loadDatabaseRules(sandbox, REFUSED);
    expect(databaseRulesSource(sandbox)).toEqual(REFUSED);
    expect(getActiveRules(sandbox)).toEqual(OPEN);
  });

  it('reads the rules in force once other rules are installed', () => {
    const sandbox = initializeSandbox();
    loadDatabaseRules(sandbox, REFUSED);
    const closed = { rules: { '.read': false } };
    installDatabaseRules(sandbox, closed);
    expect(databaseRulesSource(sandbox)).toEqual(closed);
  });

  it('lint reports a refused seed ruleset', async () => {
    const ctx = createSurfaceContext(initializeSandbox());
    loadDatabaseRules(ctx.sandbox, REFUSED);
    const result = await DATABASE_RULES.lint(ctx, undefined);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.data)).toContain('PARSE_ERROR');
  });
});

describe('loadDatabaseRules', () => {
  it('returns the reason a load path refused, naming the rule', () => {
    const refusal = loadDatabaseRules(initializeSandbox(), REFUSED);
    expect(refusal).toContain('/rooms/.write:');
  });

  it('returns null when the rules loaded', () => {
    expect(loadDatabaseRules(initializeSandbox(), OPEN)).toBeNull();
  });
});
