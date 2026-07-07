/**
 * Reattach — recovery of an interrupted server-mode response.
 *
 * Seeds the chat store with an assistant message that died mid-request
 * (partial text + a persisted `activeJob` stamp), stubs the job stream
 * endpoint, and asserts the recovered message: full text via
 * overlap-dedup (no duplicated prefix), honest notes (tool calls that
 * did not run / expired stream), and a cleared stamp.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useChatStore } from '~/lib/store/chat';
import { recoverInterruptedJobs } from './reattach';

const origFetch = globalThis.fetch;

function sseResponse(payloads: string[]): Response {
  const body = payloads.map((p) => `data: ${p}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function seedMessage(partialText: string, jobId = 'job-1'): string {
  const chat = useChatStore.getState();
  chat.appendMessage({
    id: 'u1',
    role: 'user',
    text: 'prompt',
    createdAt: 1,
  });
  chat.appendMessage({
    id: 'a1',
    role: 'assistant',
    text: partialText,
    createdAt: 2,
    streaming: true,
    activeJob: { jobId, seq: 0 },
  });
  return 'a1';
}

function message(id: string) {
  return useChatStore.getState().messages.find((m) => m.id === id)!;
}

beforeEach(() => {
  useChatStore.getState().clear();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('recoverInterruptedJobs', () => {
  test('appends only the missing suffix (overlap-dedup) and clears the stamp', async () => {
    const id = seedMessage('The answer is: one two');
    globalThis.fetch = (async (url: string | URL | Request) => {
      expect(String(url)).toContain('/api/inference/job/job-1/stream?from=0');
      return sseResponse([
        JSON.stringify({ kind: 'text', text: 'The answer is: ' }),
        JSON.stringify({ kind: 'text', text: 'one two three four.' }),
        '[DONE]',
      ]);
    }) as unknown as typeof fetch;

    await recoverInterruptedJobs();
    const m = message(id);
    // Full replay = 'The answer is: one two three four.'; message already
    // had 'The answer is: one two' → only ' three four.' is appended.
    expect(m.text).toContain('The answer is: one two three four.');
    expect(m.text).not.toContain('one two one two');
    expect(m.text).toContain('recovered the rest of this reply');
    expect(m.activeJob).toBeUndefined();
    expect(m.streaming).toBe(false);
    // Clean text-only completion — nothing to resume.
    expect(m.interrupted).toBeUndefined();
  });

  test('notes unrun tool calls in the recovered tail', async () => {
    const id = seedMessage('Working on it');
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({ kind: 'text', text: 'Working on it — done thinking.' }),
        JSON.stringify({ kind: 'tool_call', id: 'c1', name: 'write_file', args: {} }),
        '[DONE]',
      ])) as unknown as typeof fetch;

    await recoverInterruptedJobs();
    const m = message(id);
    expect(m.text).toContain('tool calls did not run');
    expect(m.activeJob).toBeUndefined();
    // Unrun tool calls → interactive resume is offered.
    expect(m.interrupted).toEqual({ toolCallsPending: true });
  });

  test('expired job (404) clears the stamp with an honest note', async () => {
    const id = seedMessage('Partial reply');
    globalThis.fetch = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch;

    await recoverInterruptedJobs();
    const m = message(id);
    expect(m.text).toContain('Partial reply');
    expect(m.text).toContain('expired');
    expect(m.activeJob).toBeUndefined();
    expect(m.streaming).toBe(false);
    // Recovery failed outright → definitely incomplete → resume offered.
    expect(m.interrupted).toEqual({ toolCallsPending: true });
  });

  test('messages without a stamp are untouched', async () => {
    const chat = useChatStore.getState();
    chat.appendMessage({ id: 'a2', role: 'assistant', text: 'finished reply', createdAt: 3 });
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response('{}');
    }) as unknown as typeof fetch;

    await recoverInterruptedJobs();
    expect(fetched).toBe(0);
    expect(message('a2').text).toBe('finished reply');
  });
});
