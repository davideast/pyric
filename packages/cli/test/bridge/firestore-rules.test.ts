/**
 * `firestore_rules` validate, end to end through the composed MCP surface
 * with a minimal rules source.
 */
import { describe, expect, it } from 'bun:test';
import { composeMcpTools, resolveToolCall, type McpTool } from '../../src/bridge/server/tool-surface.js';

const OWNER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == resource.data.owner;
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

function firestoreRules(): McpTool {
  return composeMcpTools().find((tool) => tool.name === 'firestore_rules')!;
}

async function call(args: Record<string, unknown>) {
  const resolution = resolveToolCall(firestoreRules(), args);
  if (!resolution.ok) return resolution.result;
  return resolution.op.execute!(resolution.args);
}

describe('firestore_rules.validate', () => {
  it('advertises validate as an in-process op taking a source', () => {
    const validate = firestoreRules().ops.find((op) => op.op === 'validate')!;
    expect(validate.transport).toBe('in-process');
    expect(validate.handler).toBe('firestore_validate_rules');
    expect(validate.fields).toEqual([
      { name: 'source', required: true, type: 'string', description: expect.any(String) },
    ]);
  });

  it('reports a clean source', async () => {
    const result = await call({ op: 'validate', source: OWNER_RULES });
    expect(result).toMatchObject({ ok: true, summary: 'Validation clean', data: { findings: [] } });
  });

  it('reports critical findings for an open ruleset', async () => {
    const result = await call({ op: 'validate', source: OPEN_RULES });
    expect(result.ok).toBe(false);
    const { findings } = result.data as { findings: { severity: string; code: string }[] };
    expect(findings.some((finding) => finding.severity === 'critical')).toBe(true);
  });

  it('reports a parse failure as a result and rejects unknown fields', async () => {
    const broken = await call({ op: 'validate', source: 'service cloud.firestore {' });
    expect(broken.ok).toBe(false);
    expect(broken.summary).toStartWith('Parse failed');

    const rejected = await call({ op: 'validate', source: OWNER_RULES, testCases: [] });
    expect(rejected.ok).toBe(false);
    expect(rejected.summary).toContain("'testCases' is not a field of op 'validate'");
  });
});
