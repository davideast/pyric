/**
 * The ai_logic methods, judged against the AI mirror's own client path
 * rather than the tool's own claim: `script` then a call through
 * `getGenerativeModel` answers with the scripted payload for a matching
 * prompt and falls through for a non-matching one; `scripts` lists what is
 * queued; `clearScripts` empties the queue and the next call no longer
 * matches; `status` names the engine and whether a key is configured,
 * with no key material anywhere in the result.
 */
import { afterAll, expect, it } from 'bun:test';
import { getAI, getGenerativeModel } from 'pyric/ai';
import { initializeSandbox } from 'pyric/sandbox';
import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import { aiFor } from '../../../src/bridge/surface/service-handles.js';
import { ctx, finishHandlerSuite, run } from './handler-harness.js';

afterAll(() => finishHandlerSuite('ai-logic'));

it('answers a matching prompt with the scripted payload, and a non-matching one with something else', async () => {
  const scripted = await run('ai_logic.script', {
    match: { substring: 'archive status' },
    response: { type: 'text', payload: 'The archive is offline for maintenance.' },
  });
  expect(scripted.ok).toBe(true);

  const model = getGenerativeModel(aiFor(ctx), { model: 'gemini-flash-lite-latest' });
  const hit = await model.generateContent('What is the archive status right now?');
  expect(hit.response.text()).toBe('The archive is offline for maintenance.');

  const miss = await model.generateContent('Say literally anything else.');
  expect(miss.response.text()).not.toBe('The archive is offline for maintenance.');
});

it('lists a queued script, and clearScripts empties the queue so a later call no longer matches', async () => {
  const registered = await run('ai_logic.script', {
    match: { substring: 'clear-me-marker' },
    response: { type: 'text', payload: 'still queued' },
  });
  expect(registered.ok).toBe(true);

  const listed = await run('ai_logic.scripts');
  expect(listed.ok).toBe(true);
  const { scripts } = listed.data as { scripts: Array<{ match: unknown; consumed: boolean }> };
  expect(scripts.some((entry) => JSON.stringify(entry.match).includes('clear-me-marker'))).toBe(true);

  const cleared = await run('ai_logic.clearScripts');
  expect(cleared.ok).toBe(true);

  const afterClear = await run('ai_logic.scripts');
  const { scripts: emptied } = afterClear.data as { scripts: unknown[] };
  expect(emptied).toEqual([]);

  const model = getGenerativeModel(aiFor(ctx), { model: 'gemini-flash-lite-latest' });
  const result = await model.generateContent('clear-me-marker should not match anymore');
  expect(result.response.text()).not.toBe('still queued');
});

it('a model-only match reads the requested model, not the prompt text', async () => {
  const modelName = 'gemini-flash-lite-latest';
  const registered = await run('ai_logic.script', {
    match: { model: modelName },
    response: { type: 'text', payload: 'model matched' },
  });
  expect(registered.ok).toBe(true);

  const model = getGenerativeModel(aiFor(ctx), { model: modelName });
  const result = await model.generateContent('anything at all');
  expect(result.response.text()).toBe('model matched');
});

it('reports the engine and keyPresent for the default scripted engine, with no key material', async () => {
  const status = await run('ai_logic.status');
  expect(status.ok).toBe(true);
  const data = status.data as { engine: string; keyPresent: boolean };
  expect(data.engine).toBe('scripted');
  expect(data.keyPresent).toBe(false);
});

it('never carries a planted key value, prefix, or length; only keyPresent, on a gemini-configured sandbox', async () => {
  const PLANTED_KEY = 'planted-fake-key-should-never-leak-9f2a';
  const sandbox = initializeSandbox();
  getAI(sandbox, { engine: { kind: 'gemini', apiKey: PLANTED_KEY } });
  const isolatedCtx = createSurfaceContext(sandbox, ctx.projectDir);
  const surface = renderSurface(undefined);
  const tool = surface.tools.find((candidate) => candidate.name === 'ai_logic')!;

  const status = await tool.execute({ method: 'status', args: {} }, isolatedCtx);
  expect(status.ok).toBe(true);
  const data = status.data as { engine: string; keyPresent: boolean; upstream?: string };
  expect(data.engine).toBe('gemini');
  expect(data.keyPresent).toBe(true);
  expect(Object.keys(data).sort()).toEqual(['engine', 'keyPresent', 'upstream']);

  const serialized = JSON.stringify(status);
  expect(serialized).not.toContain(PLANTED_KEY);
  expect(serialized).not.toContain(PLANTED_KEY.slice(0, 8));
  expect(serialized).not.toContain(String(PLANTED_KEY.length));
});

it('refuses a text response whose payload is not a string, naming the accepted form', async () => {
  const refused = await run('ai_logic.script', {
    match: { substring: 'x' },
    response: { type: 'text', payload: { not: 'a string' } },
  });
  expect(refused.ok).toBe(false);
  expect(refused.summary).toContain('type "text"');
});

it('refuses a json response whose payload is not a plain object, naming the accepted form', async () => {
  const refused = await run('ai_logic.script', {
    match: { substring: 'x' },
    response: { type: 'json', payload: 'not an object' },
  });
  expect(refused.ok).toBe(false);
  expect(refused.summary).toContain('type "json"');
});

it('refuses an error response whose payload is not { code, message }, naming the accepted form', async () => {
  const refused = await run('ai_logic.script', {
    match: { substring: 'x' },
    response: { type: 'error', payload: { message: 'missing a code' } },
  });
  expect(refused.ok).toBe(false);
  expect(refused.summary).toContain('type "error"');
});
