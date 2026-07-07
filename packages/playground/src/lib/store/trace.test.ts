/**
 * SF-S0a — trace-store provenance folding.
 *
 * Verifies the strategy provenance (strategy + source + reason) lands in
 * the turn's `hostCtx` regardless of whether the router milestone arrives
 * BEFORE the first `llm_request` (the usual order — routing fires first) or
 * AFTER it, and that a later escalation milestone overrides the routing
 * decision (the escalated strategy is what actually finished the turn).
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import type { LlmRequestTrace, LlmResponseTrace } from '@inbrowser/agent';
import {
  getAllTurnTraces,
  getTurnTrace,
  useTraceStore,
  type HostCtx,
  type PersistedTraceTelemetry,
  type StrategyProvenance,
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

const ROUTED: StrategyProvenance = {
  strategy: 'draft-validate',
  strategySource: 'routed',
  reason: 'build-intent + data/security signal',
};

beforeEach(() => useTraceStore.getState().clear());

describe('trace store provenance (SF-S0a)', () => {
  test('provenance BEFORE the first request lands in hostCtx (router-first order)', () => {
    const s = useTraceStore.getState();
    s.setProvenance('t1', ROUTED);
    s.appendRequest(req('t1'), CTX);
    const hc = getTurnTrace('t1')!.hostCtx;
    expect(hc.strategy).toBe('draft-validate');
    expect(hc.strategySource).toBe('routed');
    expect(hc.routerReason).toBe('build-intent + data/security signal');
    // provider/model fields preserved
    expect(hc.providerId).toBe('openrouter');
    expect(hc.modelLabel).toBe('kimi');
  });

  test('provenance AFTER the first request patches the existing hostCtx', () => {
    const s = useTraceStore.getState();
    s.appendRequest(req('t2'), CTX);
    expect(getTurnTrace('t2')!.hostCtx.strategy).toBeUndefined();
    s.setProvenance('t2', ROUTED);
    const hc = getTurnTrace('t2')!.hostCtx;
    expect(hc.strategy).toBe('draft-validate');
    expect(hc.strategySource).toBe('routed');
  });

  test('user-selected provenance carries no router reason', () => {
    const s = useTraceStore.getState();
    s.setProvenance('t3', { strategy: 'react', strategySource: 'user-selected' });
    s.appendRequest(req('t3'), CTX);
    const hc = getTurnTrace('t3')!.hostCtx;
    expect(hc.strategySource).toBe('user-selected');
    expect(hc.routerReason).toBeUndefined();
  });

  test('a later escalation overrides the earlier routing decision', () => {
    const s = useTraceStore.getState();
    s.setProvenance('t4', ROUTED); // draft-validate / routed
    s.appendRequest(req('t4'), CTX);
    s.setProvenance('t4', {
      strategy: 'react',
      strategySource: 'escalated',
      reason: 'draft-validate→react: 1 floor-case failure(s) after repairs exhausted',
    });
    const hc = getTurnTrace('t4')!.hostCtx;
    expect(hc.strategy).toBe('react');
    expect(hc.strategySource).toBe('escalated');
    expect(hc.routerReason).toContain('floor-case');
  });

  test('subsequent requests for the turn keep the first hostCtx (incl. provenance)', () => {
    const s = useTraceStore.getState();
    s.setProvenance('t5', ROUTED);
    s.appendRequest(req('t5', 0), CTX);
    s.appendRequest(req('t5', 1), { ...CTX, modelLabel: 'swapped' });
    const turn = getTurnTrace('t5')!;
    expect(turn.requests.length).toBe(2);
    // hostCtx captured once at the first request, provenance intact
    expect(turn.hostCtx.modelLabel).toBe('kimi');
    expect(turn.hostCtx.strategy).toBe('draft-validate');
  });

  test('clear() drops pending provenance too', () => {
    const s = useTraceStore.getState();
    s.setProvenance('t6', ROUTED);
    s.clear();
    s.appendRequest(req('t6'), CTX);
    expect(getTurnTrace('t6')!.hostCtx.strategy).toBeUndefined();
  });

  test('snapshot() and hydrate() round-trip trace detail', () => {
    const s = useTraceStore.getState();
    s.setProvenance('t7', ROUTED);
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
    expect(restored.hostCtx.strategy).toBe('draft-validate');
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
