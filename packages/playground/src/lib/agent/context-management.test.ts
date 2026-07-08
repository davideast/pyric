/** VENDORED tests — mirror of @inbrowser/agent context-management; delete with the vendored module. */
import { describe, expect, test } from 'bun:test';
import {
  applyCompactionMarker,
  buildCompactionPrompt,
  editToolResults,
  isClearedResult,
  mechanicalSummary,
  shouldCompact,
  splitForCompaction,
  type CompactionMarker,
} from './context-management';
import type { ModelContextMessageLike } from '@inbrowser/agent/usage';

function msg(
  id: string,
  role: string,
  text: string,
  toolResults: string[] = [],
): ModelContextMessageLike {
  return {
    id,
    role,
    text,
    toolCalls: toolResults.map((r, i) => ({
      id: `${id}-t${i}`,
      name: 'read_file',
      argsJson: `{"path":"/workspace/f${i}.ts"}`,
      resultJson: r,
    })),
  };
}

function session(turns: number): ModelContextMessageLike[] {
  const out: ModelContextMessageLike[] = [];
  for (let t = 0; t < turns; t++) {
    out.push(msg(`u${t}`, 'user', `prompt ${t}`));
    out.push(msg(`a${t}`, 'assistant', `answer ${t}`, ['x'.repeat(5000)]));
  }
  return out;
}

describe('editToolResults (lever 1)', () => {
  test('clears results older than the keep window, keeps text + args', () => {
    const { messages, stats } = editToolResults(session(6), { keepResultsRecentTurns: 2 });
    expect(stats.clearedResults).toBe(4);
    expect(isClearedResult(messages[1]!.toolCalls![0]!.resultJson)).toBe(true);
    expect(messages[1]!.text).toBe('answer 0');
    expect(messages[1]!.toolCalls![0]!.argsJson).toContain('/workspace/f0.ts');
    expect(isClearedResult(messages[9]!.toolCalls![0]!.resultJson)).toBe(false);
    expect(stats.clearedChars).toBeGreaterThan(4 * 4000);
  });

  test('idempotent: second application is a byte-identical no-op on the prefix', () => {
    const first = editToolResults(session(6), { keepResultsRecentTurns: 2 });
    const second = editToolResults(first.messages, { keepResultsRecentTurns: 2 });
    expect(second.stats.clearedResults).toBe(0);
    expect(JSON.stringify(second.messages.slice(0, 8))).toBe(
      JSON.stringify(first.messages.slice(0, 8)),
    );
    expect(second.messages[0]).toBe(first.messages[0]);
  });

  test('short sessions are untouched', () => {
    const { messages, stats } = editToolResults(session(2), { keepResultsRecentTurns: 4 });
    expect(stats.clearedResults).toBe(0);
    expect(isClearedResult(messages[1]!.toolCalls![0]!.resultJson)).toBe(false);
  });
});

describe('shouldCompact (lever 2 trigger)', () => {
  test('respects the window ratio when the window is small', () => {
    const d = shouldCompact(session(40), { windowTokens: 10_000, ratio: 0.7 });
    expect(d.thresholdTokens).toBe(7000);
    expect(d.compact).toBe(d.historyTokens > 7000);
  });

  test('hard cap wins on huge windows', () => {
    const d = shouldCompact(session(3), { windowTokens: 1_000_000 });
    expect(d.thresholdTokens).toBe(150_000);
    expect(d.compact).toBe(false);
  });

  test('no window → hard cap only', () => {
    const d = shouldCompact(session(3), {});
    expect(d.thresholdTokens).toBe(150_000);
  });
});

describe('splitForCompaction / applyCompactionMarker', () => {
  test('splits at the keep boundary and round-trips through a marker', () => {
    const messages = session(8);
    const split = splitForCompaction(messages, { keepRecentUserTurns: 3 })!;
    expect(split).not.toBeNull();
    expect(split.older.length).toBe(10);
    expect(split.recent[0]!.id).toBe('u5');
    expect(split.atMessageId).toBe('a4');

    const marker: CompactionMarker = {
      atMessageId: split.atMessageId,
      summaryText: 'the memory',
      beforeTokens: 100,
      afterTokens: 10,
      ts: 1234,
      source: 'model',
    };
    const applied = applyCompactionMarker(marker, messages, (input) => ({ ...input }));
    expect(applied.applied).toBe(true);
    expect(applied.messages[0]!.text).toContain('the memory');
    expect(applied.messages[1]!.id).toBe('u5');
    expect(applied.messages.length).toBe(1 + 6);
  });

  test('too few turns → null (nothing to compact)', () => {
    expect(splitForCompaction(session(3), { keepRecentUserTurns: 4 })).toBeNull();
  });

  test('missing boundary id fails OPEN (full history, applied=false)', () => {
    const marker: CompactionMarker = {
      atMessageId: 'gone',
      summaryText: 's',
      beforeTokens: 0,
      afterTokens: 0,
      ts: 1,
      source: 'mechanical',
    };
    const messages = session(2);
    const applied = applyCompactionMarker(marker, messages, (input) => ({ ...input }));
    expect(applied.applied).toBe(false);
    expect(applied.messages.length).toBe(messages.length);
  });

  test('marker-of-marker: a summary message participates in the next split', () => {
    const messages = session(8);
    const split1 = splitForCompaction(messages, { keepRecentUserTurns: 3 })!;
    const marker: CompactionMarker = {
      atMessageId: split1.atMessageId,
      summaryText: 'gen1',
      beforeTokens: 0,
      afterTokens: 0,
      ts: 1,
      source: 'model',
    };
    const gen1 = applyCompactionMarker(marker, messages, (i) => ({ ...i })).messages;
    const grown = [...gen1, ...session(6).map((m) => ({ ...m, id: `g2-${m.id}` }))];
    const split2 = splitForCompaction(grown, { keepRecentUserTurns: 3 });
    expect(split2).not.toBeNull();
    expect(split2!.older.some((m) => m.text.includes('gen1'))).toBe(true);
  });
});

describe('prompts + fallback', () => {
  test('compaction prompt carries the contract and the history', () => {
    const p = buildCompactionPrompt(session(3));
    expect(p).toContain('MEMORY DOCUMENT');
    expect(p).toContain('OPEN THREADS');
    expect(p).toContain('prompt 0');
    expect(p).toContain('read_file');
  });

  test('mechanical fallback is deterministic and bounded', () => {
    const a = mechanicalSummary(session(50));
    const b = mechanicalSummary(session(50));
    expect(a).toBe(b);
    expect(a).toContain('mechanically compacted');
  });
});
