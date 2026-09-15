import { expect, test } from 'bun:test';
import { initializeSandbox, captureFullState } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { createConfiguredSandboxAI, getAiEvidence } from '../../src/ai/internal.js';
import { getAI, getGenerativeModel } from '../../src/ai/index.js';

const modelName = 'gemini-2.5-flash';

test('configuration revisions share session events and capture while a pending request retains its route', async () => {
  const sandbox = initializeSandbox();
  getClock(sandbox).set(1_800_000_000_000);
  const events: ReturnType<typeof sandbox.history> = [];
  const stop = sandbox.onEvent(event => events.push(event));
  let release!: (response: Response) => void;
  let submittedModel: unknown;
  const routes = { [modelName]: 'ornith:9b' };
  const first = getGenerativeModel(createConfiguredSandboxAI(sandbox, { engine: {
    kind: 'openai', baseUrl: 'http://model.test/v1', modelMap: routes,
    fetch: async (_url, init) => {
      submittedModel = JSON.parse(String(init?.body)).model;
      return new Promise<Response>(resolve => { release = resolve; });
    },
  } }), { model: modelName });
  try {
    routes[modelName] = 'changed-after-handle-creation';
    const pending = first.generateContent('First');
    expect(submittedModel).toBe('ornith:9b');
    const next = getGenerativeModel(createConfiguredSandboxAI(sandbox, { engine: {
      kind: 'scripted', script: [{ respond: { text: 'Second response' } }],
    } }), { model: modelName });
    const second = await next.generateContent('Second');
    expect(getAiEvidence(second.response)?.engine).toBe('scripted');
    release(new Response(JSON.stringify({ model: 'ornith:9b', choices: [{ index: 0, message: { role: 'assistant', content: 'First response' }, finish_reason: 'stop' }] })));
    const completed = await pending;
    expect(getAiEvidence(completed.response)).toMatchObject({ engine: 'openai', routedModel: 'ornith:9b', reportedModel: 'ornith:9b' });
    const fixture = { state: await captureFullState(sandbox), events: sandbox.history() };
    const aiEvents = fixture.events.filter(event => event.kind === 'service_mutation' && event.service === 'ai');
    expect(aiEvents.filter(event => event.kind === 'service_mutation' && event.op === 'generate_content')).toHaveLength(2);
    expect(aiEvents.every(event => event.at === 1_800_000_000_000)).toBe(true);
    expect(aiEvents.every(event => events.some(observed => observed.id === event.id))).toBe(true);
    expect(fixture.events.some(event => event.kind === 'session_boundary' && event.phase === 'dispose')).toBe(false);
    // Host revisions do not overwrite the ordinary SDK's cached handle.
    const cached = getAI(sandbox);
    createConfiguredSandboxAI(sandbox, { engine: { kind: 'scripted' } });
    expect(getAI(sandbox)).toBe(cached);
  } finally { stop(); sandbox.dispose(); }
});

test('switching configuration while consuming a stream keeps its chunks and completion in the original session', async () => {
  const sandbox = initializeSandbox();
  try {
    const original = getGenerativeModel(createConfiguredSandboxAI(sandbox, { engine: {
      kind: 'scripted', script: [{ respond: { chunks: ['old ', 'route'] } }],
    } }), { model: modelName });
    const streaming = await original.generateContentStream('First');
    const replacement = getGenerativeModel(createConfiguredSandboxAI(sandbox, { engine: {
      kind: 'scripted', script: [{ respond: { text: 'new route' } }],
    } }), { model: modelName });
    await replacement.generateContent('Second');
    let text = '';
    for await (const chunk of streaming.stream) text += chunk.text();
    expect(text).toBe('old route');
    expect((await streaming.response).text()).toBe('old route');
    const aiEvents = sandbox.history().filter(event => event.kind === 'service_mutation' && event.service === 'ai');
    expect(aiEvents.filter(event => event.kind === 'service_mutation' && event.op === 'stream_generate_content')).toHaveLength(1);
    expect(aiEvents.filter(event => event.kind === 'service_mutation' && event.op === 'generate_content')).toHaveLength(1);
  } finally { sandbox.dispose(); }
});
