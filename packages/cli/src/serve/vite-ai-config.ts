import type { AIOptions } from 'pyric/ai';
import path from 'node:path';
import { loadEnv } from 'vite';
import type { AiEngineConfigWire } from './worker/protocol.js';

const AI_PROXY_PATH = '/__pyric/ai-proxy';

/** Declarative AI engines that can cross Vite's page/SharedWorker boundary. */
export type PyricAiEngineConfig = Extract<NonNullable<AIOptions['engine']>, { kind: string }>;

export interface PyricAiOptions {
  /** Mode for AI Logic: 'sandbox' (local mirrors) or 'production' (pass-through to Google AI / Vertex AI). */
  mode?: 'sandbox' | 'production';
  /** Simple OpenAI-compatible model selection through Pyric's same-origin proxy. */
  model?: string;
  /** Advanced declarative engine configuration. */
  engine?: PyricAiEngineConfig;
  /** OpenAI-compatible upstream used by the same-origin proxy. */
  proxyUpstream?: string;
}

export interface ResolvedViteAiConfig {
  mode: 'sandbox' | 'production';
  engineWire: AiEngineConfigWire | undefined;
  proxyUpstream: string | undefined;
}

/** Values captured once by a SharedWorker and therefore requiring replacement. */
export function viteWorkerEpochSalt(
  projectKey: string,
  engineWire: AiEngineConfigWire | undefined,
  mode: 'sandbox' | 'production' = 'sandbox',
): string {
  return JSON.stringify({ projectKey, aiEngine: engineWire ?? null, aiMode: mode });
}

/** Load env using Vite's `envDir`-relative-to-root convention. */
export function loadViteAiEnv(
  mode: string,
  root: string | undefined,
  envDir: string | undefined,
): Record<string, string> {
  const resolvedRoot = path.resolve(root ?? process.cwd());
  const resolvedEnvDir = envDir === undefined
    ? resolvedRoot
    : path.resolve(resolvedRoot, envDir);
  return loadEnv(mode, resolvedEnvDir, '');
}

/** Convert a public declarative engine into the JSON-safe worker wire shape. */
export function engineConfigToWire(engine: PyricAiEngineConfig): AiEngineConfigWire {
  const isOpenAiEngine = engine.kind === 'openai';
  if (isOpenAiEngine) {
    const result: Record<string, unknown> = {
      kind: 'openai',
      baseUrl: engine.baseUrl !== undefined && engine.baseUrl !== null ? engine.baseUrl : AI_PROXY_PATH,
    };
    const hasModel = engine.model !== undefined;
    if (hasModel) {
      result.model = engine.model;
    }
    const hasModelMap = engine.modelMap !== undefined;
    if (hasModelMap) {
      result.modelMap = engine.modelMap;
    }
    return result as AiEngineConfigWire;
  }
  const isGeminiEngine = engine.kind === 'gemini';
  if (isGeminiEngine) {
    const result: Record<string, unknown> = {
      kind: 'gemini',
    };
    const hasBaseUrl = engine.baseUrl !== undefined;
    if (hasBaseUrl) {
      result.baseUrl = engine.baseUrl;
    }
    const hasApiKey = engine.apiKey !== undefined;
    if (hasApiKey) {
      result.apiKey = engine.apiKey;
    }
    return result as AiEngineConfigWire;
  }
  const result: Record<string, unknown> = {
    kind: 'scripted',
  };
  const hasScript = engine.script !== undefined;
  if (hasScript) {
    result.script = engine.script as unknown as Array<Record<string, unknown>>;
  }
  return result as AiEngineConfigWire;
}

/** Resolve the plugin's explicit-options-over-Vite-env AI convention. */
export function resolveViteAiConfig(
  options: PyricAiOptions | undefined,
  env: Record<string, string | undefined>,
): ResolvedViteAiConfig {
  const explicitModel = options?.model;
  const explicitEngine = options?.engine;
  const hasModelOption = explicitModel !== undefined;
  const hasEngineOption = explicitEngine !== undefined;
  const hasBothModelAndEngine = hasModelOption && hasEngineOption;
  if (hasBothModelAndEngine) {
    throw new Error('@pyric/cli/vite: Choose either ai.model or ai.engine, not both.');
  }

  let mode: 'sandbox' | 'production' = 'sandbox';
  const explicitMode = options?.mode;
  const hasExplicitMode = explicitMode !== undefined;
  if (hasExplicitMode) {
    mode = explicitMode;
  } else {
    const isEnvProductionMode = env.PYRIC_AI_MODE === 'production';
    const isEnvPassthroughFlag = env.PYRIC_AI_PASSTHROUGH === '1';
    const isProductionEnv = isEnvProductionMode || isEnvPassthroughFlag;
    if (isProductionEnv) {
      mode = 'production';
    }
  }

  const isProductionMode = mode === 'production';
  const hasAnyEngineConfig = hasModelOption || hasEngineOption;
  const isInvalidProductionConfig = isProductionMode && hasAnyEngineConfig;
  if (isInvalidProductionConfig) {
    throw new Error('@pyric/cli/vite: Cannot configure ai.model or ai.engine when ai.mode is set to "production".');
  }

  let model: string | undefined = undefined;
  const envModel = env.PYRIC_AI_MODEL;
  if (explicitModel !== undefined) {
    model = explicitModel.trim();
  } else if (envModel !== undefined) {
    model = envModel.trim();
  }
  const hasNonEmptyModel = model !== undefined && model !== '';
  if (!hasNonEmptyModel) {
    model = undefined;
  }

  let engineWire: AiEngineConfigWire | undefined = undefined;
  if (isProductionMode) {
    engineWire = { kind: 'gemini' };
  } else if (explicitEngine !== undefined) {
    engineWire = engineConfigToWire(explicitEngine);
  } else if (model !== undefined) {
    engineWire = engineConfigToWire({ kind: 'openai', baseUrl: AI_PROXY_PATH, model });
  }

  let proxyUpstream: string | undefined = undefined;
  const explicitProxyUpstream = options?.proxyUpstream;
  const envProxyUpstream = env.PYRIC_AI_PROXY_UPSTREAM;
  if (explicitProxyUpstream !== undefined) {
    proxyUpstream = explicitProxyUpstream.trim();
  } else if (envProxyUpstream !== undefined) {
    proxyUpstream = envProxyUpstream.trim();
  }
  const hasNonEmptyProxyUpstream = proxyUpstream !== undefined && proxyUpstream !== '';
  if (!hasNonEmptyProxyUpstream) {
    proxyUpstream = undefined;
  }

  return {
    mode,
    engineWire,
    proxyUpstream,
  };
}
