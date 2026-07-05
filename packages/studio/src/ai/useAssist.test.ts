import { describe, expect, it } from 'bun:test';
import type { ModelEvent, ModelClient, SessionEvent } from '@inbrowser/agent';
import {
  foldAssistEvent,
  runAssist,
  INITIAL_ASSIST_STATE,
  type AssistState,
} from './useAssist.js';

/** A fake ModelClient that yields a scripted ModelEvent list (no network / key). */
function fakeLlm(events: ModelEvent[]): ModelClient {
  return {
    id: 'fake',
    supportsTools: true,
    async *chat() {
      for (const e of events) yield e;
    },
  };
}

describe('foldAssistEvent (pure reducer)', () => {
  const T = 't1';

  it('turn_started -> running, text accumulates', () => {
    let s = foldAssistEvent(INITIAL_ASSIST_STATE, { kind: 'turn_started', turnId: T });
    expect(s.status).toBe('running');
    s = foldAssistEvent(s, { kind: 'text', turnId: T, chunk: 'hel' });
    s = foldAssistEvent(s, { kind: 'text', turnId: T, chunk: 'lo' });
    expect(s.text).toBe('hello');
  });

  it('tool_started adds a running step; tool_finished resolves it', () => {
    let s = foldAssistEvent(INITIAL_ASSIST_STATE, {
      kind: 'tool_started',
      turnId: T,
      callId: 'c1',
      name: 'try_rules_edit',
      args: { rules: '...' },
    });
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0]).toMatchObject({ callId: 'c1', name: 'try_rules_edit', status: 'running' });
    s = foldAssistEvent(s, {
      kind: 'tool_finished',
      turnId: T,
      callId: 'c1',
      result: { ok: true, summary: 'unblocked the op' },
    });
    expect(s.steps[0]).toMatchObject({ status: 'ok', summary: 'unblocked the op' });
  });

  it('a failed tool result marks the step error', () => {
    const started = foldAssistEvent(INITIAL_ASSIST_STATE, {
      kind: 'tool_started', turnId: T, callId: 'c2', name: 'seed', args: {},
    });
    const finished = foldAssistEvent(started, {
      kind: 'tool_finished', turnId: T, callId: 'c2', result: { ok: false, summary: 'cap exceeded' },
    });
    expect(finished.steps[0]).toMatchObject({ status: 'error', summary: 'cap exceeded' });
  });

  it('error -> error status; completed -> done (but error wins)', () => {
    expect(foldAssistEvent(INITIAL_ASSIST_STATE, { kind: 'error', message: 'boom' }).status).toBe('error');
    const running: AssistState = { ...INITIAL_ASSIST_STATE, status: 'running' };
    expect(foldAssistEvent(running, { kind: 'completed' }).status).toBe('done');
    const errored: AssistState = { ...INITIAL_ASSIST_STATE, status: 'error', error: 'x' };
    expect(foldAssistEvent(errored, { kind: 'completed' }).status).toBe('error');
  });

  it('ignores events the assist UI does not surface', () => {
    const before: AssistState = { ...INITIAL_ASSIST_STATE, status: 'running', text: 'keep' };
    const after = foldAssistEvent(before, {
      kind: 'turn_completed',
      turnId: T,
      metrics: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0, costUsd: 0 },
      details: { requestedModel: 'm' },
    } as SessionEvent);
    expect(after).toEqual(before);
  });
});

describe('runAssist (end to end with a fake LlmClient)', () => {
  it('runs a plain-chat turn to done with accumulated text', async () => {
    const llm = fakeLlm([
      { kind: 'text', text: 'hello ' },
      { kind: 'text', text: 'world' },
      { kind: 'usage', usage: { promptTokens: 1, outputTokens: 2 } },
    ]);
    const run = runAssist({ llm, systemPrompt: 'be brief' }, 'hi', () => {});
    const final = await run.done;
    expect(final.status).toBe('done');
    expect(final.text).toBe('hello world');
  });

  it('surfaces an LLM error as an error state', async () => {
    const llm = fakeLlm([{ kind: 'error', message: 'rate limited' }]);
    const run = runAssist({ llm, systemPrompt: 'x' }, 'hi', () => {});
    const final = await run.done;
    expect(final.status).toBe('error');
  });
});
