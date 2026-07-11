/**
 * Red conformance suite: `ChatSession` rows (ai#chat-*). One test per
 * registry row id. The single-user-turn row pins the ruling that the mirror
 * implements the 2.13.0 fixed sendMessageStream semantics rather than the
 * installed 2.12.0 duplicate-user-turn bug (cdd-deltas ruling 3).
 * RED BY DESIGN until the ai mirror lands (CDD map #92).
 */
import { describe, expect, test } from 'bun:test';
import { dataKeys, aiSeam, observedBehavior, PROBE_MODEL, type AiSeam } from './support.ts';

const envelope = observedBehavior('ai-generate-minimal-envelope');

let seam: AiSeam;

/** Loads the seam inside the test so every row id reports its own red. */
function rowTest(name: string, fn: () => Promise<void> | void): void {
  test(name, async () => {
    seam = await aiSeam();
    await fn();
  });
}

function freshAi(entries?: any[]): { ai: any; model: any } {
  const sandbox = seam.sandboxMod.initializeSandbox();
  const ai = seam.ai.getAI(sandbox);
  if (entries) seam.scripting.script(ai, entries);
  const model = seam.ai.getGenerativeModel(ai, { model: PROBE_MODEL });
  return { ai, model };
}

describe('ai: ChatSession history and streaming turns', () => {
  rowTest('ai#chat-startchat startChat returns a session seeded with StartChatParams.history', async () => {
    const { model } = freshAi();
    const seeded = [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ];
    const chat = model.startChat({ history: seeded });
    const history = await chat.getHistory();
    expect(history.length).toBe(2);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('model');
  });

  rowTest('ai#chat-history-threads sendMessage appends the user and model turns in order', async () => {
    const { model } = freshAi([
      { respond: { text: 'first answer' } },
      { respond: { text: 'second answer' } },
    ]);
    const chat = model.startChat();
    await chat.sendMessage('first question');
    await chat.sendMessage('second question');
    const history = await chat.getHistory();
    expect(history.map((content: any) => content.role)).toEqual(['user', 'model', 'user', 'model']);
    expect(history[0].parts[0].text).toBe('first question');
    expect(history[1].parts[0].text).toBe('first answer');
    expect(history[2].parts[0].text).toBe('second question');
    expect(history[3].parts[0].text).toBe('second answer');
  });

  rowTest('ai#chat-history-excludes-blocked blocked prompts and candidates are excluded from getHistory', async () => {
    const blockedEnvelope = {
      promptFeedback: { blockReason: 'SAFETY', safetyRatings: [] },
    };
    const { model } = freshAi([{ respond: blockedEnvelope }]);
    const chat = model.startChat();
    await chat.sendMessage('a blocked prompt').catch(() => undefined);
    const history = await chat.getHistory();
    expect(history.length).toBe(0);
  });

  rowTest('ai#chat-sendmessage-envelope a sendMessage result carries the generateContent envelope facts', async () => {
    const { model } = freshAi();
    const chat = model.startChat();
    const result = await chat.sendMessage('Reply with exactly one word.');
    expect(dataKeys(result.response)).toEqual([...envelope.topLevelKeySet].sort());
    expect(result.response.candidates[0].content.role).toBe(envelope.contentRole);
  });

  rowTest('ai#chat-sendmessagestream sendMessageStream returns stream plus response and history updates after aggregation', async () => {
    const { model } = freshAi([{ respond: { chunks: ['streamed', ' answer'] } }]);
    const chat = model.startChat();
    const result = await chat.sendMessageStream('stream a reply');
    const chunks: any[] = [];
    for await (const chunk of result.stream) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);
    const aggregated = await result.response;
    expect(aggregated.text()).toBe('streamed answer');
    const history = await chat.getHistory();
    expect(history.map((content: any) => content.role)).toEqual(['user', 'model']);
  });

  rowTest('ai#chat-stream-single-user-turn exactly one user turn is recorded per sendMessageStream call (2.13.0 fixed semantics, not the 2.12.0 duplicate-turn bug)', async () => {
    const { model } = freshAi([{ respond: { chunks: ['ok'] } }]);
    const chat = model.startChat();
    const sent = 'only once please';
    const result = await chat.sendMessageStream(sent);
    for await (const _chunk of result.stream) {
      // drain
    }
    await result.response;
    const history = await chat.getHistory();
    const userTurns = history.filter((content: any) => content.role === 'user');
    expect(userTurns.length).toBe(1);
    expect(userTurns[0].parts[0].text).toBe(sent);
  });

  rowTest('ai#chat-role-vocabulary POSSIBLE_ROLES is exactly user, model, function, system', () => {
    expect(seam.ai.POSSIBLE_ROLES).toEqual(['user', 'model', 'function', 'system']);
  });
});
