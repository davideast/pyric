import { describe, expect, it } from 'bun:test';
import { buildRulesFixPrompt, RULES_FIX_SYSTEM, makeTestRulesEditTool } from './rules-fix.js';

describe('buildRulesFixPrompt', () => {
  it('describes the denied op + the current rules + asks for a verified fix', () => {
    const prompt = buildRulesFixPrompt({
      method: 'create',
      path: 'secret/x',
      auth: { uid: 'bob' },
      rulesSource: 'match /secret/{id} { allow read, write: if false; }',
      requestData: { hush: true },
    });
    expect(prompt).toContain('create secret/x');
    expect(prompt).toContain('signed in as bob');
    expect(prompt).toContain('if false');
    expect(prompt).toContain('test_rules_edit');
  });
});

describe('RULES_FIX_SYSTEM', () => {
  it('constrains to the smallest non-over-granting edit + zero regressions', () => {
    expect(RULES_FIX_SYSTEM).toContain('SMALLEST');
    expect(RULES_FIX_SYSTEM.toLowerCase()).toContain('without over-granting');
    expect(RULES_FIX_SYSTEM).toContain('ZERO regressions');
  });
});

describe('makeTestRulesEditTool', () => {
  const tool = makeTestRulesEditTool({
    denial: {} as never,
    getSnapshot: async () => null,
    recentOps: [],
    onVerifiedFix: () => {},
  });

  it('declares the test_rules_edit tool with a required rules param', () => {
    expect(tool.name).toBe('test_rules_edit');
    expect(tool.parameters.required).toEqual(['rules']);
  });

  it('returns not-ok when no rules are provided', async () => {
    const res = await tool.execute({ rules: '' }, { signal: new AbortController().signal });
    expect(res.ok).toBe(false);
  });

  it('returns not-ok when no snapshot is available', async () => {
    const res = await tool.execute({ rules: 'rules_version = "2";' }, { signal: new AbortController().signal });
    expect(res.ok).toBe(false);
    expect(res.summary.toLowerCase()).toContain('snapshot');
  });
});
