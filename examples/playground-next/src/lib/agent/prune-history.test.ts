/** Tests for bounded tool-result history (#515) — pure transform, no I/O. */
import { describe, test, expect } from 'bun:test';
import type { ModelClient } from '@inbrowser/agent';
import {
  pruneToolHistory,
  pruneToolHistoryWithStats,
  withPrunedHistory,
  type NormMsgLike,
  type PruneStats,
} from './prune-history';

const sys: NormMsgLike = { role: 'system', text: 'SYS' };
const user: NormMsgLike = { role: 'user', text: 'build it' };
const asst = (n: number): NormMsgLike => ({ role: 'assistant', text: `step ${n}` });
// A fat tool result: ok + summary + a bulky data trace.
const toolResult = (n: number): NormMsgLike => ({
  role: 'tool',
  callId: `c${n}`,
  name: 'simulate_firestore_write',
  resultJson: JSON.stringify({
    ok: true,
    summary: `simulate · create pub/${n} → DENY`,
    data: { decision: 'DENY', trace: Array.from({ length: 50 }, (_, i) => ({ source: `expr ${i}`, value: false })) },
  }),
});

/** Interleave N (assistant, tool) pairs after the system+user preamble. */
function convo(n: number): NormMsgLike[] {
  const out: NormMsgLike[] = [sys, user];
  for (let i = 1; i <= n; i++) out.push(asst(i), toolResult(i));
  return out;
}

describe('pruneToolHistory (#515)', () => {
  test('keeps the last K tool results verbatim, summarizes older ones', () => {
    const msgs = convo(8);
    const { messages, stats } = pruneToolHistoryWithStats(msgs, { keepLastResults: 3 });
    const tools = messages.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(8);
    // first 5 summarized, last 3 intact
    expect(stats.pruned).toBe(5);
    const summarized = tools.slice(0, 5);
    const kept = tools.slice(5);
    for (const t of summarized) {
      const p = JSON.parse(t.resultJson!);
      expect(p._pruned).toBe(true);
      expect(p.summary).toContain('DENY'); // one-line summary preserved
      expect(p.data).toBeUndefined(); // bulky trace dropped
    }
    for (const t of kept) {
      expect(JSON.parse(t.resultJson!).data.trace).toHaveLength(50); // full trace retained
    }
  });

  test('the most-recent result is always intact (model sees its latest output)', () => {
    const msgs = convo(5);
    const out = pruneToolHistory(msgs, { keepLastResults: 1 });
    const tools = out.filter((m) => m.role === 'tool');
    expect(JSON.parse(tools.at(-1)!.resultJson!).data.trace).toHaveLength(50);
    expect(JSON.parse(tools[0]!.resultJson!)._pruned).toBe(true);
  });

  test('no-op when tool results <= K', () => {
    const msgs = convo(2);
    const { messages, stats } = pruneToolHistoryWithStats(msgs, { keepLastResults: 3 });
    expect(stats.pruned).toBe(0);
    expect(stats.bytesSaved).toBe(0);
    expect(messages).toEqual(msgs);
  });

  test('non-tool messages are never touched', () => {
    const msgs = convo(6);
    const out = pruneToolHistory(msgs, { keepLastResults: 2 });
    expect(out.filter((m) => m.role !== 'tool')).toEqual(msgs.filter((m) => m.role !== 'tool'));
  });

  test('idempotent — re-pruning an already-pruned history is stable', () => {
    const once = pruneToolHistory(convo(7), { keepLastResults: 3 });
    const twice = pruneToolHistory(once, { keepLastResults: 3 });
    expect(twice).toEqual(once);
  });

  test('bytesSaved is substantial for fat traces', () => {
    const { stats } = pruneToolHistoryWithStats(convo(10), { keepLastResults: 3 });
    expect(stats.pruned).toBe(7);
    expect(stats.bytesSaved).toBeGreaterThan(1000); // 7 dropped 50-entry traces
  });
});

describe('withPrunedHistory — the live-session client seam (harness policy: keepLastResults 3)', () => {
  test('inner client sees pruned messages; recent results intact; stats via onPrune', async () => {
    let seen: NormMsgLike[] = [];
    const inner = {
      id: 'fake',
      supportsTools: true,
      async *chat(req: { messages: NormMsgLike[] }) {
        seen = req.messages;
        yield { kind: 'text', chunk: 'ok' };
      },
    } as unknown as ModelClient;
    const stats: PruneStats[] = [];
    const wrapped = withPrunedHistory(inner, { keepLastResults: 3, onPrune: (s) => stats.push(s) });
    const out: unknown[] = [];
    const chat = wrapped.chat as (r: unknown, s: AbortSignal) => AsyncIterable<unknown>;
    for await (const e of chat({ messages: convo(8), tools: [] }, new AbortController().signal)) {
      out.push(e);
    }
    const tools = seen.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(8);
    expect(JSON.parse(tools[0]!.resultJson!)._pruned).toBe(true); // old → stub
    expect(JSON.parse(tools.at(-1)!.resultJson!).data.trace).toHaveLength(50); // recent intact
    expect(stats).toEqual([{ pruned: 5, bytesSaved: stats[0]!.bytesSaved }]);
    expect(stats[0]!.bytesSaved).toBeGreaterThan(1000);
    expect(out).toEqual([{ kind: 'text', chunk: 'ok' }]); // events pass through
  });
});
