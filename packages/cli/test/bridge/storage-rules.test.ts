/**
 * `storage_rules` lint and simulate, end to end through the composed MCP
 * surface: the op is selected and validated by `resolveToolCall`, then the
 * in-process handler runs with a minimal rules source.
 */
import { describe, expect, it } from 'bun:test';
import { composeMcpTools, resolveToolCall, type McpTool } from '../../src/bridge/server/tool-surface.js';

const OWNER_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{file} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;

function storageRules(): McpTool {
  return composeMcpTools().find((tool) => tool.name === 'storage_rules')!;
}

async function call(args: Record<string, unknown>) {
  const resolution = resolveToolCall(storageRules(), args);
  if (!resolution.ok) return resolution.result;
  return resolution.op.execute!(resolution.args);
}

describe('storage_rules', () => {
  it('advertises resolve, lint, and simulate as in-process ops', () => {
    const tool = storageRules();
    expect(tool.ops.map((op) => [op.op, op.transport])).toEqual([
      ['resolve', 'in-process'],
      ['lint', 'in-process'],
      ['simulate', 'in-process'],
    ]);
    expect(tool.parameters.properties!.op).toMatchObject({ enum: ['resolve', 'lint', 'simulate'] });
  });

  it('lint reports a clean source and a parse failure', async () => {
    const clean = await call({ op: 'lint', source: OWNER_RULES });
    expect(clean.ok).toBe(true);
    expect(clean.data).toMatchObject({ warnings: [], metrics: { sourceSize: OWNER_RULES.length } });

    const broken = await call({ op: 'lint', source: 'service firebase.storage {' });
    expect(broken.ok).toBe(false);
    expect(broken.summary).toStartWith('Parse failed');
  });

  it('simulate evaluates one request against the supplied source', async () => {
    const request = {
      auth: { uid: 'alice' },
      method: 'create',
      path: 'b/pyric-default/o/users/alice/pic.png',
      resource: { size: 4 },
    };
    const allowed = await call({ op: 'simulate', source: OWNER_RULES, request });
    expect(allowed).toMatchObject({ ok: true, data: { allowed: true } });

    const denied = await call({
      op: 'simulate',
      source: OWNER_RULES,
      request: { ...request, auth: null },
      resource: null,
      now: '2026-01-01T00:00:00Z',
    });
    expect(denied).toMatchObject({ ok: true, data: { allowed: false } });
  });

  it('rejects fields the op does not accept and a missing request', async () => {
    const rejected = await call({ op: 'lint', source: OWNER_RULES, request: {} });
    expect(rejected.ok).toBe(false);
    expect(rejected.summary).toContain("'request' is not a field of op 'lint'");

    const missing = await call({ op: 'simulate', source: OWNER_RULES });
    expect(missing.ok).toBe(false);
    expect(missing.summary).toContain("'request' is required");
  });
});
