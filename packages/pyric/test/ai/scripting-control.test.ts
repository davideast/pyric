/**
 * Unit coverage for the scripting control surface the `ai_logic` service
 * tool builds on: clearing and listing the scripted engine's queue, matching
 * on the requested model as well as the prompt text, and reading the
 * resolved engine's status without ever exposing a key.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';

import { getAI, getGenerativeModel } from '../../src/ai/index.js';
import { aiStatus, clearScripts, script, scripts } from '../../src/ai/scripting.js';
import { AIError, AIErrorCode } from '../../src/ai/errors.js';

const MODEL = 'gemini-flash-lite-latest';

describe('clearScripts', () => {
  it('empties the queue; a call that matched before now falls through to the default', async () => {
    const sandbox = initializeSandbox();
    const ai = getAI(sandbox);
    script(ai, [{ match: 'ping', respond: { text: 'pong' } }]);
    clearScripts(ai);
    const model = getGenerativeModel(ai, { model: MODEL });
    const result = await model.generateContent('ping');
    expect(result.response.text()).not.toBe('pong');
  });

  it('refuses a non-scripted engine, matching script()', () => {
    const sandbox = initializeSandbox();
    const ai = getAI(sandbox, { engine: { kind: 'openai', baseUrl: 'http://localhost:1/v1' } });
    let thrown: unknown;
    try {
      clearScripts(ai);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AIError);
    expect((thrown as AIError).code).toBe(AIErrorCode.UNSUPPORTED);
  });
});

describe('scripts', () => {
  it('lists queued entries, each beside whether it has been consumed', async () => {
    const sandbox = initializeSandbox();
    const ai = getAI(sandbox);
    script(ai, [{ match: 'ping', respond: { text: 'pong' } }]);
    const beforeCall = scripts(ai);
    expect(beforeCall).toHaveLength(1);
    expect(beforeCall[0]!.consumed).toBe(false);

    const model = getGenerativeModel(ai, { model: MODEL });
    await model.generateContent('ping');

    const afterCall = scripts(ai);
    expect(afterCall).toHaveLength(1);
    expect(afterCall[0]!.consumed).toBe(true);
  });

  it('is empty for a fresh sandbox', () => {
    const ai = getAI(initializeSandbox());
    expect(scripts(ai)).toEqual([]);
  });
});

describe('model matching', () => {
  it('a predicate matcher reads the requested model, not only the prompt text', async () => {
    const sandbox = initializeSandbox();
    const ai = getAI(sandbox);
    const model = getGenerativeModel(ai, { model: MODEL });
    script(ai, [
      { match: (_req, requestedModel) => requestedModel === model.model, respond: { text: 'model matched' } },
    ]);
    const result = await model.generateContent('anything');
    expect(result.response.text()).toBe('model matched');
  });

  it('a predicate naming a different model never matches', async () => {
    const sandbox = initializeSandbox();
    const ai = getAI(sandbox);
    script(ai, [
      { match: (_req, model) => model === 'some-other-model', respond: { text: 'wrong model' } },
    ]);
    const model = getGenerativeModel(ai, { model: MODEL });
    const result = await model.generateContent('anything');
    expect(result.response.text()).not.toBe('wrong model');
  });
});

describe('aiStatus', () => {
  it('reports the scripted engine with no key and no upstream', () => {
    const ai = getAI(initializeSandbox());
    expect(aiStatus(ai)).toEqual({ engine: 'scripted', keyPresent: false });
  });

  it('reports the gemini engine, its upstream, and key presence from an explicit key', () => {
    const ai = getAI(initializeSandbox(), {
      engine: { kind: 'gemini', apiKey: 'test-key-should-never-appear', baseUrl: 'https://example.test' },
    });
    const status = aiStatus(ai);
    expect(status.engine).toBe('gemini');
    expect(status.upstream).toBe('https://example.test');
    expect(status.keyPresent).toBe(true);
    expect(JSON.stringify(status)).not.toContain('test-key-should-never-appear');
  });

  it('reports the gemini engine with no key configured', () => {
    const originalGemini = process.env.GEMINI_API_KEY;
    const originalGoogle = process.env.GOOGLE_GENAI_API_KEY;
    const originalVite = process.env.VITE_GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;
    delete process.env.VITE_GEMINI_API_KEY;
    try {
      const ai = getAI(initializeSandbox(), { engine: { kind: 'gemini' } });
      expect(aiStatus(ai).keyPresent).toBe(false);
    } finally {
      if (originalGemini !== undefined) process.env.GEMINI_API_KEY = originalGemini;
      if (originalGoogle !== undefined) process.env.GOOGLE_GENAI_API_KEY = originalGoogle;
      if (originalVite !== undefined) process.env.VITE_GEMINI_API_KEY = originalVite;
    }
  });

  it('reports the openai engine, with its model and upstream', () => {
    const ai = getAI(initializeSandbox(), {
      engine: { kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
    });
    expect(aiStatus(ai)).toEqual({
      engine: 'openai',
      model: 'llama3',
      upstream: 'http://localhost:11434/v1',
      keyPresent: false,
    });
  });
});
