/**
 * Conformance suite for AI handle initialization and dispatch (ai#getai-*,
 * ai#backend-*, ai#model-name-*). One test per registry row id.
 * RED BY DESIGN until the ai mirror lands (CDD map #92).
 */
import { describe, expect, test } from 'bun:test';
import { aiSeam, PROBE_MODEL, type AiSeam } from './support.ts';

let seam: AiSeam;
let sandbox: any;

/** Loads the seam inside the test so every row id reports its own red. */
function rowTest(name: string, fn: () => Promise<void> | void): void {
  test(name, async () => {
    seam = await aiSeam();
    sandbox ??= seam.sandboxMod.initializeSandbox();
    await fn();
  });
}

describe('ai: initialization and dispatch', () => {
  rowTest('ai#getai-sandbox-dispatch getAI(sandbox) returns a sandbox-bound AI handle that answers in-process', async () => {
    const ai = seam.ai.getAI(sandbox);
    expect(ai).toBeDefined();
    const model = seam.ai.getGenerativeModel(ai, { model: PROBE_MODEL });
    const result = await model.generateContent('Say hello.');
    expect(Array.isArray(result.response.candidates)).toBe(true);
    expect(result.response.candidates.length).toBeGreaterThan(0);
  });

  rowTest('ai#getai-app-dispatch getAI(app) uses the app sandbox selected by package resolution and carries the app', async () => {
    const { deleteApp } = await import('pyric/app');
    const { createAppForSandbox } = await import('pyric/app/internal');
    const app = createAppForSandbox(
      sandbox,
      { projectId: 'ai-test' },
      'ai-app-dispatch',
    );
    try {
      const ai = seam.ai.getAI(app);
      expect(ai.app).toBe(app);
    } finally {
      await deleteApp(app);
    }
  });

  rowTest('ai#getai-default-backend the backend defaults to GoogleAIBackend with backendType GOOGLE_AI', () => {
    const ai = seam.ai.getAI(sandbox);
    expect(ai.backend).toBeInstanceOf(seam.ai.GoogleAIBackend);
    expect(ai.backend.backendType).toBe(seam.ai.BackendType.GOOGLE_AI);
    expect(ai.location).toBe('');
  });

  rowTest('ai#getai-idempotent repeat getAI calls with the same target return a stable handle', () => {
    expect(seam.ai.getAI(sandbox)).toBe(seam.ai.getAI(sandbox));
  });

  rowTest('ai#getai-engine-option explicit scripted engine behaves identically to the zero-config default', async () => {
    const explicitSandbox = seam.sandboxMod.initializeSandbox();
    const defaultSandbox = seam.sandboxMod.initializeSandbox();
    const explicitAi = seam.ai.getAI(explicitSandbox, {
      backend: new seam.ai.GoogleAIBackend(),
      engine: { kind: 'scripted' },
    });
    const defaultAi = seam.ai.getAI(defaultSandbox);
    const request = 'Reply with one word.';
    const fromExplicit = await seam.ai.getGenerativeModel(explicitAi, { model: PROBE_MODEL }).generateContent(request);
    const fromDefault = await seam.ai.getGenerativeModel(defaultAi, { model: PROBE_MODEL }).generateContent(request);
    expect(fromExplicit.response.candidates).toEqual(fromDefault.response.candidates);
  });

  rowTest('ai#backend-vertex VertexAIBackend carries VERTEX_AI and location defaults to us-central1', () => {
    const backend = new seam.ai.VertexAIBackend();
    expect(backend.backendType).toBe(seam.ai.BackendType.VERTEX_AI);
    expect(backend.location).toBe('us-central1');
    const ai = seam.ai.getAI(seam.sandboxMod.initializeSandbox(), { backend });
    expect(ai.location).toBe('us-central1');
  });

  rowTest('ai#model-name-short a short model name normalizes to the models/ resource name', () => {
    const ai = seam.ai.getAI(sandbox);
    const model = seam.ai.getGenerativeModel(ai, { model: PROBE_MODEL });
    expect(model.model).toBe(`models/${PROBE_MODEL}`);
  });

  rowTest('ai#model-name-prefixed a models/-prefixed name is accepted without double prefixing', () => {
    const ai = seam.ai.getAI(sandbox);
    const model = seam.ai.getGenerativeModel(ai, { model: `models/${PROBE_MODEL}` });
    expect(model.model).toBe(`models/${PROBE_MODEL}`);
    expect(model.model).not.toContain('models/models/');
  });

  rowTest('ai#model-name-required getGenerativeModel without modelParams.model throws AIError no-model', () => {
    const ai = seam.ai.getAI(sandbox);
    let thrown: any;
    try {
      seam.ai.getGenerativeModel(ai, {} as any);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(String(thrown.code)).toContain('no-model');
  });

  rowTest('ai#getai-sandbox-no-network the scripted engine performs no network I/O', async () => {
    const isolated = seam.sandboxMod.initializeSandbox();
    const ai = seam.ai.getAI(isolated, { engine: { kind: 'scripted' } });
    const model = seam.ai.getGenerativeModel(ai, { model: PROBE_MODEL });
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    (globalThis as any).fetch = (...args: unknown[]) => {
      fetchCalls += 1;
      throw new Error(`unexpected network I/O from the scripted engine: ${String(args[0])}`);
    };
    try {
      const result = await model.generateContent('No network allowed.');
      expect(result.response.candidates.length).toBeGreaterThan(0);
      expect(fetchCalls).toBe(0);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });
});
