import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  engineConfigToWire,
  loadViteAiEnv,
  resolveViteAiConfig,
  viteWorkerEpochSalt,
} from '../../src/serve/vite-ai-config.js';

describe('Vite AI configuration', () => {
  it('converts declarative engine configs to worker-safe wire values', () => {
    expect(
      engineConfigToWire({
        kind: 'openai',
        baseUrl: 'http://host/v1',
        model: 'm',
        modelMap: { a: 'b' },
      }),
    ).toEqual({
      kind: 'openai',
      baseUrl: 'http://host/v1',
      model: 'm',
      modelMap: { a: 'b' },
    });
    expect(
      engineConfigToWire({ kind: 'scripted', script: [{ respond: { text: 'hi' } }] }),
    ).toEqual({
      kind: 'scripted',
      script: [{ respond: { text: 'hi' } }],
    });
  });

  it('turns a model into an OpenAI engine through Pyric\'s same-origin proxy', () => {
    expect(resolveViteAiConfig({ model: ' qwen3:4b ' }, {})).toEqual({
      engineWire: {
        kind: 'openai',
        baseUrl: '/__pyric/ai-proxy',
        model: 'qwen3:4b',
      },
      proxyUpstream: undefined,
    });
  });

  it('uses Vite env when plugin options do not select a model or upstream', () => {
    expect(resolveViteAiConfig(undefined, {
      PYRIC_AI_MODEL: ' llama3.2 ',
      PYRIC_AI_PROXY_UPSTREAM: ' http://model.test:8080/v1 ',
    })).toEqual({
      engineWire: {
        kind: 'openai',
        baseUrl: '/__pyric/ai-proxy',
        model: 'llama3.2',
      },
      proxyUpstream: 'http://model.test:8080/v1',
    });
  });

  it('loads AI variables from a custom Vite envDir relative to the Vite root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pyric-vite-ai-env-dir-'));
    mkdirSync(path.join(root, 'config'));
    writeFileSync(
      path.join(root, 'config', '.env.local'),
      'PYRIC_AI_MODEL=custom-env-model\nPYRIC_AI_PROXY_UPSTREAM=http://custom.test/v1\n',
    );

    expect(loadViteAiEnv('development', root, 'config')).toMatchObject({
      PYRIC_AI_MODEL: 'custom-env-model',
      PYRIC_AI_PROXY_UPSTREAM: 'http://custom.test/v1',
    });
  });

  it('gives explicit model and upstream precedence over conflicting env', () => {
    expect(resolveViteAiConfig({
      model: 'explicit-model',
      proxyUpstream: 'http://explicit.test/v1',
    }, {
      PYRIC_AI_MODEL: 'env-model',
      PYRIC_AI_PROXY_UPSTREAM: 'http://env.test/v1',
    })).toEqual({
      engineWire: {
        kind: 'openai',
        baseUrl: '/__pyric/ai-proxy',
        model: 'explicit-model',
      },
      proxyUpstream: 'http://explicit.test/v1',
    });
  });

  it('gives an explicit engine precedence over a conflicting env model', () => {
    expect(resolveViteAiConfig({
      engine: { kind: 'scripted', script: [{ respond: { text: 'explicit' } }] },
    }, {
      PYRIC_AI_MODEL: 'env-model',
    })).toEqual({
      engineWire: {
        kind: 'scripted',
        script: [{ respond: { text: 'explicit' } }],
      },
      proxyUpstream: undefined,
    });
  });

  it('leaves the engine unset so the app\'s first getAI() call keeps control', () => {
    expect(resolveViteAiConfig(undefined, {})).toEqual({
      engineWire: undefined,
      proxyUpstream: undefined,
    });
  });

  it('rejects ambiguous model and engine options', () => {
    expect(() => resolveViteAiConfig({
      model: 'qwen3:4b',
      engine: { kind: 'scripted' },
    }, {})).toThrow('Choose either ai.model or ai.engine');
  });

  it('changes worker boot identity when the project or AI engine changes', () => {
    const scripted = viteWorkerEpochSalt('/app', undefined);
    const openai = viteWorkerEpochSalt('/app', {
      kind: 'openai',
      baseUrl: '/__pyric/ai-proxy',
      model: 'qwen3:4b',
    });

    expect(openai).not.toBe(scripted);
    expect(viteWorkerEpochSalt('/other-app', undefined)).not.toBe(scripted);
  });
});
