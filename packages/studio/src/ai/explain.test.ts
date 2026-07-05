import { describe, expect, it } from 'bun:test';
import { buildDenialExplainPrompt, RULES_EXPLAIN_SYSTEM } from './explain.js';

describe('buildDenialExplainPrompt', () => {
  it('includes the operation, auth context, and the rules', () => {
    const prompt = buildDenialExplainPrompt({
      method: 'create',
      path: 'secret/x',
      auth: { uid: 'alice' },
      rulesSource: 'match /secret/{id} { allow read, write: if false; }',
      requestData: { hush: true },
    });
    expect(prompt).toContain('create secret/x');
    expect(prompt).toContain('signed in as alice');
    expect(prompt).toContain('"hush":true');
    expect(prompt).toContain('if false');
  });

  it('marks an unauthenticated request and omits absent data', () => {
    const prompt = buildDenialExplainPrompt({
      method: 'get',
      path: 'secret/x',
      auth: null,
      rulesSource: 'rules_version = "2";',
    });
    expect(prompt).toContain('null (unauthenticated)');
    expect(prompt).not.toContain('request.resource.data:');
    expect(prompt).not.toContain('existing document');
  });

  it('has a system prompt that constrains scope', () => {
    expect(RULES_EXPLAIN_SYSTEM).toContain('Security Rules');
    expect(RULES_EXPLAIN_SYSTEM.toLowerCase()).toContain('do not write the full ruleset');
  });
});
