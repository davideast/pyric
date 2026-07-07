import { describe, test, expect } from 'bun:test';
import type { ChatMessage } from '~/lib/store/chat';
import {
  buildAssistantTimeline,
  hasInterleavedTimeline,
  isThinkingOnlyTurn,
  lastTextTimelineIndex,
} from './chat-timeline';

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return { id: 'm', role: 'assistant', text: '', createdAt: 1000, ...overrides };
}

describe('buildAssistantTimeline', () => {
  test('interleaves thinking → tool → thinking → tool by ts', () => {
    const timeline = buildAssistantTimeline(
      msg({
        thinking: 'firstsecond',
        thinkingChunks: [
          { text: 'first', ts: 1100 },
          { text: 'second', ts: 1300 },
        ],
        toolCalls: [
          { id: 'c1', name: 'read_file', argsJson: '{}', emittedAt: 1200 },
          { id: 'c2', name: 'write_file', argsJson: '{}', emittedAt: 1400 },
        ],
      }),
    );
    expect(timeline?.map((it) => it.kind)).toEqual(['thinking', 'tool', 'thinking', 'tool']);
  });

  test('live thinking tail streams after the last snapshotted event', () => {
    const timeline = buildAssistantTimeline(
      msg({
        streaming: true,
        thinking: 'abc',
        toolCalls: [{ id: 'c1', name: 'bash', argsJson: '{}', emittedAt: 2000 }],
      }),
      { streaming: true },
    );
    const thinking = timeline?.filter((it) => it.kind === 'thinking') ?? [];
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ text: 'abc', live: true });
    expect(thinking[0]!.ts).toBeGreaterThan(2000);
  });

  test('derives legacy thinking deltas from thinkingUpToHere', () => {
    const timeline = buildAssistantTimeline(
      msg({
        thinking: 'onetwo',
        toolCalls: [
          {
            id: 'c1',
            name: 'read_file',
            argsJson: '{}',
            emittedAt: 1200,
            thinkingUpToHere: 'one',
          },
          {
            id: 'c2',
            name: 'write_file',
            argsJson: '{}',
            emittedAt: 1400,
            thinkingUpToHere: 'onetwo',
          },
        ],
      }),
    );
    expect(timeline?.map((it) => it.kind)).toEqual(['thinking', 'tool', 'thinking', 'tool']);
    const thinking = timeline!.filter((it) => it.kind === 'thinking');
    expect(thinking[0]).toMatchObject({ text: 'one' });
    expect(thinking[1]).toMatchObject({ text: 'two' });
  });

  test('tools without text chunks still produce a timeline', () => {
    const timeline = buildAssistantTimeline(
      msg({
        thinkingChunks: [{ text: 'plan', ts: 1050 }],
        toolCalls: [{ id: 'c1', name: 'list_files', argsJson: '{}', emittedAt: 1100 }],
      }),
    );
    expect(timeline?.map((it) => it.kind)).toEqual(['thinking', 'tool']);
  });
});

describe('hasInterleavedTimeline', () => {
  test('true when thinking precedes tools', () => {
    expect(
      hasInterleavedTimeline(
        msg({
          thinking: 'x',
          toolCalls: [{ id: 'c1', name: 'bash', argsJson: '{}', emittedAt: 1 }],
        }),
      ),
    ).toBe(true);
  });
});

describe('isThinkingOnlyTurn', () => {
  test('true for reasoning with no tools', () => {
    expect(isThinkingOnlyTurn(msg({ thinking: 'ponder' }))).toBe(true);
  });
});

describe('lastTextTimelineIndex', () => {
  test('finds trailing reply chunk', () => {
    const timeline = buildAssistantTimeline(
      msg({
        textChunks: [
          { text: 'mid', ts: 100 },
          { text: 'reply', ts: 200 },
        ],
        toolCalls: [{ id: 'c1', name: 'bash', argsJson: '{}', emittedAt: 150 }],
      }),
    )!;
    expect(lastTextTimelineIndex(timeline)).toBe(2);
  });
});
