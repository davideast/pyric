import { describe, test, expect } from 'bun:test';
import type { ChatMessage } from '~/lib/store/chat';
import { deriveTurnStatus, isReplyHiddenWhileStreaming } from './derive-turn-status';

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm',
    role: 'assistant',
    text: '',
    createdAt: 1,
    ...overrides,
  };
}

describe('deriveTurnStatus', () => {
  test('returns null when not streaming', () => {
    expect(deriveTurnStatus(msg({ streaming: false, text: 'hi' }))).toBeNull();
  });

  test('starting turn before any activity', () => {
    expect(deriveTurnStatus(msg({ streaming: true }))).toEqual({
      label: 'Starting turn…',
      showStrip: true,
    });
  });

  test('in-flight ReAct tool on any provider', () => {
    const status = deriveTurnStatus(
      msg({
        streaming: true,
        providerLabel: 'Gemini',
        toolCalls: [{ id: 'c1', name: 'write_file', argsJson: '{}', summary: 'write_file · running…' }],
      }),
    );
    expect(status?.label).toBe('WRITE FILE · running…');
    expect(status?.showStrip).toBe(true);
  });

  test('in-flight delegated activity', () => {
    const status = deriveTurnStatus(
      msg({
        streaming: true,
        providerLabel: 'Claude (local CLI)',
        delegatedActivity: [
          {
            id: 'd1',
            name: 'read_file',
            summary: 'read /workspace/firestore.rules',
            ts: 1,
          },
        ],
      }),
    );
    expect(status?.label).toBe('read /workspace/firestore.rules…');
  });

  test('reasoning only — strip hidden, thinking fold carries progress', () => {
    expect(
      deriveTurnStatus(msg({ streaming: true, thinking: 'ponder', providerLabel: 'OpenRouter' })),
    ).toEqual({ label: 'Reasoning…', showStrip: false });
  });

  test('visible reply streaming — no status strip', () => {
    expect(
      deriveTurnStatus(
        msg({ streaming: true, text: 'Hello', providerLabel: 'Gemini' }),
      ),
    ).toBeNull();
  });
});

describe('isReplyHiddenWhileStreaming', () => {
  test('Claude delegated lane hides reply while streaming', () => {
    expect(
      isReplyHiddenWhileStreaming(
        msg({ streaming: true, providerLabel: 'Claude (local CLI)' }),
      ),
    ).toBe(true);
  });

  test('Gemini shows reply while streaming', () => {
    expect(
      isReplyHiddenWhileStreaming(msg({ streaming: true, providerLabel: 'Gemini' })),
    ).toBe(false);
  });
});
