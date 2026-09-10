/**
 * The CLI's call into a running bridge: how one MCP tool response is read, and
 * what a bridge that does not serve the tool is reported as.
 *
 * The discovery and the round trip that surround it are exercised by the
 * commands that use them (`test/cli/auth-identity.test.ts` for
 * `pyric auth reset`, `test/cli/serve-sessions.test.ts` for
 * `pyric serve sessions`), so this file is about the response reading alone.
 */
import { describe, expect, it } from 'bun:test';
import { parseToolResponse } from '../../src/cli/bridge-tool-call.js';

describe('parseToolResponse', () => {
  it('reads a tool result from the text block', () => {
    expect(
      parseToolResponse('auth_whoami', {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, summary: 's', data: { a: 1 } }) }],
      }),
    ).toEqual({ ok: true, summary: 's', data: { a: 1 } });
  });

  it('reports a bridge that does not serve the tool instead of a parse failure', () => {
    const result = parseToolResponse('auth_reset', {
      isError: true,
      content: [{ type: 'text', text: 'MCP error -32602: Tool auth_reset not found' }],
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Tool auth_reset not found');
    expect(result.summary).toContain('may predate the auth_reset tool');
    expect(result.data).toMatchObject({ code: 'auth/unsupported-bridge' });
  });

  it('reports an empty response', () => {
    expect(parseToolResponse('auth_sessions', {}).summary).toContain('empty response');
  });
});
