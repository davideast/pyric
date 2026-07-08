import { describe, test, expect, beforeEach } from 'bun:test';
import type { LlmRequestTrace, LlmResponseTrace } from '@inbrowser/agent';
import {
  getAllTurnTraces,
  getTurnTrace,
  useTraceStore,
  type HostCtx,
  type PersistedTraceTelemetry,
} from './trace';

function req(turnId: string, iteration = 0): LlmRequestTrace {
  return {
    requestId: `${turnId}#${iteration}`,
    turnId,
    iteration,
    ts: Date.now(),
    systemPrompt: 'sys',
    messages: [],
    toolDeclarations: [],
  } as unknown as LlmRequestTrace;
}

function res(turnId: string, iteration = 0): LlmResponseTrace {
  return {
    requestId: `${turnId}#${iteration}`,
    ts: Date.now(),
    text: 'ok',
  } as unknown as LlmResponseTrace;
}

const CTX: HostCtx = {
  providerId: 'openrouter',
  providerLabel: 'OpenRouter',
  modelLabel: 'kimi',
  diagnosticsEnabled: false,
  resumableServerMode: false,
};

beforeEach(() => useTraceStore.getState().clear());

describe('trace store request context', () => {
  test('first request captures host context', () => {
    const s = useTraceStore.getState();
    s.appendRequest(req('t1'), CTX);
    const hc = getTurnTrace('t1')!.hostCtx;
    expect(hc.providerId).toBe('openrouter');
    expect(hc.modelLabel).toBe('kimi');
    expect(hc.resumableServerMode).toBe(false);
  });

  test('subsequent requests for the turn keep the first host context', () => {
    const s = useTraceStore.getState();
    s.appendRequest(req('t2'), CTX);
    s.appendRequest(req('t2', 1), { ...CTX, modelLabel: 'swapped' });
    const turn = getTurnTrace('t2')!;
    expect(turn.requests.length).toBe(2);
    expect(turn.hostCtx.modelLabel).toBe('kimi');
  });

  test('clear() drops captured traces', () => {
    const s = useTraceStore.getState();
    s.appendRequest(req('t3'), CTX);
    s.clear();
    expect(getTurnTrace('t3')).toBeUndefined();
    expect(useTraceStore.getState().summaries).toEqual({});
  });

  test('snapshot() and hydrate() round-trip trace detail', () => {
    const s = useTraceStore.getState();
    s.appendRequest(req('t7', 0), CTX);
    s.appendRequest(req('t7', 1), CTX);
    s.appendResponse(res('t7', 0));

    const snapshot = useTraceStore.getState().snapshot();
    expect(snapshot.summary).toMatchObject({
      turnsWithTraces: 1,
      requestCount: 2,
      responseCount: 1,
    });

    s.clear();
    expect(getTurnTrace('t7')).toBeUndefined();

    useTraceStore.getState().hydrate(snapshot);
    const restored = getTurnTrace('t7')!;
    expect(restored.requests.length).toBe(2);
    expect(restored.responses.length).toBe(1);
    expect(restored.hostCtx.providerLabel).toBe('OpenRouter');
  });

  test('hydrate() ignores malformed telemetry instead of keeping stale traces', () => {
    const s = useTraceStore.getState();
    s.appendRequest(req('stale'), CTX);

    s.hydrate({
      version: 1,
      capturedAt: Date.now(),
      summary: { turnsWithTraces: 99, requestCount: 99, responseCount: 99 },
      tracesByTurn: {
        bad: { turnId: 'bad', requests: [], responses: [], hostCtx: {} },
      },
    } as unknown as PersistedTraceTelemetry);

    expect(getAllTurnTraces()).toEqual({});
    expect(useTraceStore.getState().summaries).toEqual({});
  });
});

// ── Content interning (perf: dedupe repeated payload across iterations) ──

function fullReq(turnId: string, iteration: number): LlmRequestTrace {
  return {
    requestId: `${turnId}#${iteration}`,
    turnId,
    iteration,
    ts: 1700000000000 + iteration,
    systemPrompt: 'SHARED SYSTEM PROMPT '.repeat(50),
    messages: [
      { role: 'system', text: 'shared leading system message' },
      { role: 'user', text: `unique message for iteration ${iteration}` },
    ],
    tools: [
      { name: 'write_file', description: 'shared tool decl', parameters: { type: 'object' } },
    ],
    llm: { id: 'test-model', supportsTools: true },
  } as unknown as LlmRequestTrace;
}

describe('trace store content interning', () => {
  test('repeated system prompt / tools / messages share one instance across requests', () => {
    const s = useTraceStore.getState();
    for (let i = 0; i < 5; i++) s.appendRequest(fullReq('turn', i), CTX);
    const trace = getTurnTrace('turn')!;
    expect(trace.requests.length).toBe(5);
    const [first, ...restReqs] = trace.requests;
    for (const r of restReqs) {
      // Identical content → the SAME instance, not an equal copy.
      expect(r.systemPrompt).toBe(first!.systemPrompt);
      expect(r.tools).toBe(first!.tools);
      expect(r.messages[0]).toBe(first!.messages[0]!); // shared leading msg
    }
    // Distinct content keeps its own entry (lossless).
    expect(restReqs[0]!.messages[1]).not.toBe(first!.messages[1]!);
  });

  test('persisted v2 snapshot stores repeated content once and round-trips losslessly', () => {
    const s = useTraceStore.getState();
    for (let i = 0; i < 5; i++) s.appendRequest(fullReq('turn', i), CTX);
    const before = getTurnTrace('turn')!;

    const snapshot = useTraceStore.getState().snapshot();
    expect(snapshot.version).toBe(2);
    // Content table: 1 system prompt + 1 tools + 1 shared msg + 5 unique msgs = 8.
    expect(Object.keys(snapshot.content).length).toBe(8);
    // The snapshot must be dramatically smaller than the inline-duplicated form.
    const dedupedBytes = JSON.stringify(snapshot).length;
    const inlineBytes = JSON.stringify({ tracesByTurn: { turn: before } }).length;
    expect(dedupedBytes).toBeLessThan(inlineBytes / 2);

    s.clear();
    useTraceStore.getState().hydrate(snapshot);
    const after = getTurnTrace('turn')!;
    expect(after.requests.length).toBe(5);
    // Full fidelity: every request restores to deep-equal content.
    for (let i = 0; i < 5; i++) {
      expect(after.requests[i]).toEqual(before.requests[i]!);
    }
    // And restored content is shared again (deduped heap after reload).
    expect(after.requests[1]!.systemPrompt).toBe(after.requests[0]!.systemPrompt);
    expect(after.requests[1]!.tools).toBe(after.requests[0]!.tools);
  });

  test('legacy v1 snapshots (inline traces) hydrate losslessly', () => {
    const v1 = {
      version: 1,
      capturedAt: Date.now(),
      summary: { turnsWithTraces: 1, requestCount: 2, responseCount: 0 },
      tracesByTurn: {
        old: {
          turnId: 'old',
          requests: [fullReq('old', 0), fullReq('old', 1)],
          responses: [],
          hostCtx: CTX,
        },
      },
    };
    useTraceStore.getState().hydrate(v1 as never);
    const restored = getTurnTrace('old')!;
    expect(restored.requests.length).toBe(2);
    expect(restored.requests[0]!.systemPrompt).toContain('SHARED SYSTEM PROMPT');
    // v1 content is interned on load too.
    expect(restored.requests[1]!.systemPrompt).toBe(restored.requests[0]!.systemPrompt);
    expect(useTraceStore.getState().summaries.old).toMatchObject({
      requestCount: 2,
      responseCount: 0,
    });
  });

  test('summaries are the reactive signal: appends bump counts without exposing payloads', () => {
    const s = useTraceStore.getState();
    s.appendRequest(fullReq('t9', 0), CTX);
    s.appendResponse(res('t9', 0));
    const summary = useTraceStore.getState().summaries.t9!;
    expect(summary).toMatchObject({ turnId: 't9', requestCount: 1, responseCount: 1 });
    expect('requests' in summary).toBe(false);
  });
});
