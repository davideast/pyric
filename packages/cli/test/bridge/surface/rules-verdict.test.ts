/**
 * The two failures that are the surface working: what marks one, what each is
 * told to call next, and what is left alone.
 */
import { describe, expect, it } from 'bun:test';

import {
  DENIED_BY_RULES_CODE,
  LINT_FINDINGS_CODE,
  explainDenialSentence,
  markDenial,
  markLintFindings,
} from '../../../src/bridge/surface/rules-verdict.js';

/** One result's data as a record, for reading the code back. */
function codeOf(data: unknown): unknown {
  return (data as { code?: unknown } | undefined)?.code;
}

describe('markDenial', () => {
  it('names the trace call and marks a refused Firestore read', () => {
    const marked = markDenial('firestore', {
      ok: false,
      summary: 'get orders/o2 denied by rules',
    });
    expect(marked.summary).toBe(
      "get orders/o2 denied by rules Call rules.explainDenial with service 'firestore' for the trace.",
    );
    expect(codeOf(marked.data)).toBe(DENIED_BY_RULES_CODE);
  });

  it('names the service that refused the call', () => {
    for (const service of ['firestore', 'database', 'storage']) {
      const marked = markDenial(service, { ok: false, summary: 'write / denied by rules' });
      expect(marked.summary).toContain(explainDenialSentence(service));
    }
  });

  it('marks a refusal the sandbox worded as a permission error', () => {
    const marked = markDenial('storage', {
      ok: false,
      summary: 'PERMISSION_DENIED: get on uploads/report.pdf denied by rules',
    });
    expect(codeOf(marked.data)).toBe(DENIED_BY_RULES_CODE);
  });

  it('keeps the data a failure already carried', () => {
    const marked = markDenial('firestore', {
      ok: false,
      summary: 'get orders/o2 denied by rules',
      data: { path: 'orders/o2' },
    });
    expect(marked.data).toEqual({ path: 'orders/o2', code: DENIED_BY_RULES_CODE });
  });

  it('leaves a call that succeeded alone', () => {
    const result = { ok: true, summary: 'get orders/o1' };
    expect(markDenial('firestore', result)).toBe(result);
  });

  it('leaves a failure that rules never refused alone', () => {
    const result = { ok: false, summary: 'orders/o2 does not exist' };
    expect(markDenial('firestore', result)).toBe(result);
  });

  it('leaves a tool whose calls rules do not govern alone', () => {
    const result = { ok: false, summary: 'get orders/o2 denied by rules' };
    expect(markDenial('sandbox', result)).toBe(result);
  });
});

describe('markLintFindings', () => {
  it('marks a lint that reported findings', () => {
    const marked = markLintFindings({
      ok: false,
      summary: 'Lint found 1 error, 0 warnings',
      data: { warnings: [] },
    });
    expect(codeOf(marked.data)).toBe(LINT_FINDINGS_CODE);
    expect(marked.summary).toBe('Lint found 1 error, 0 warnings');
  });

  it('leaves a clean lint alone', () => {
    const result = { ok: true, summary: 'Lint clean' };
    expect(markLintFindings(result)).toBe(result);
  });
});
