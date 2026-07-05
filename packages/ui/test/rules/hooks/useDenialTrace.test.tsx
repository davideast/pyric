import { describe, it, expect } from 'bun:test';
import { renderHook } from '../../helpers/render-hook.js';
import { useDenialTrace, type DenialRequest } from '../../../src/rules/index.js';
import { NOTES_RULES } from '../helpers/fixtures.js';

describe('useDenialTrace', () => {
  it('produces the deciding evaluation + line for a real denial', () => {
    const request: DenialRequest = {
      method: 'update',
      path: 'notes/3agHoZHZ',
      auth: { uid: 'alice', token: {} },
      requestData: { title: 'edited', owner: 'bob' },
      resourceData: { title: 'orig', owner: 'bob' },
    };
    const { result } = renderHook(() => useDenialTrace(request, NOTES_RULES));
    expect(result.current.ok).toBe(true);
    expect(result.current.evaluation.length).toBe(1);
    const deciding = result.current.evaluation[0];
    expect(deciding.verdict).toBe('DENY');
    expect(deciding.line).toBe(6);
    expect(deciding.conditionText).toBe('request.auth.uid == resource.data.owner');
    // The trace carries the real values that decided it.
    const sources = deciding.expressionTrace!.map((e) => e.source);
    expect(sources).toContain('request.auth.uid');
    expect(sources).toContain('resource.data.owner');
  });

  it('returns path resolution and an empty evaluation for a no-match denial', () => {
    const request: DenialRequest = {
      method: 'get',
      path: 'widgets/x/sub/y',
      auth: { uid: 'alice', token: {} },
    };
    const { result } = renderHook(() => useDenialTrace(request, NOTES_RULES));
    expect(result.current.ok).toBe(true);
    expect(result.current.evaluation).toEqual([]);
    expect(result.current.pathResolution).toBeDefined();
    const attempts = result.current.pathResolution!.attempts;
    expect(attempts.length).toBeGreaterThan(0);
    // The only block is /notes/{noteId}; the request path mismatches on the literal.
    expect(attempts[0].matched).toBe(false);
    expect(attempts[0].reason).toBe('literal-mismatch');
  });

  it('surfaces a parse failure as ok:false', () => {
    const request: DenialRequest = { method: 'get', path: 'notes/x', auth: null };
    const { result } = renderHook(() => useDenialTrace(request, ''));
    expect(result.current.ok).toBe(false);
    expect(result.current.error).toBeDefined();
  });
});
