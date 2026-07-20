import type { AIOptions } from 'pyric/ai';
import path from 'node:path';
import { loadEnv } from 'vite';
import type { AiEngineConfigWire } from './worker/protocol.js';

const AI_PROXY_PATH = '/__pyric/ai-proxy';

/** Declarative AI engines that can cross Vite's page/SharedWorker boundary. */
export type PyricAiEngineConfig = Extract<NonNullable<AIOptions['engine']>, { kind: string }>;

export interface PyricAiOptions {
  /** Simple OpenAI-compatible model selection through Pyric's same-origin proxy. */
  model?: string;
  /** Advanced declarative engine configuration. */
  engine?: PyricAiEngineConfig;
  /** OpenAI-compatible upstream used by the same-origin proxy. */
  proxyUpstream?: string;
}

export interface ResolvedViteAiConfig {
  engineWire: AiEngineConfigWire | undefined;
  proxyUpstream: string | undefined;
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
  if (engine.kind === 'openai') {
    return {
      kind: 'openai',
      baseUrl: engine.baseUrl ?? AI_PROXY_PATH,
      ...(engine.model !== undefined ? { model: engine.model } : {}),
      ...(engine.modelMap !== undefined ? { modelMap: engine.modelMap } : {}),
    };
  }
  return {
    kind: 'scripted',
    ...(engine.script !== undefined
      ? { script: engine.script as unknown as Array<Record<string, unknown>> }
      : {}),
  };
}

/** Resolve the plugin's explicit-options-over-Vite-env AI convention. */
export function resolveViteAiConfig(
  options: PyricAiOptions | undefined,
  env: Record<string, string | undefined>,
): ResolvedViteAiConfig {
  if (options?.model !== undefined && options.engine !== undefined) {
    throw new Error('@pyric/cli/vite: Choose either ai.model or ai.engine, not both.');
  }

  const model = options?.model?.trim() || env.PYRIC_AI_MODEL?.trim();
  const engineWire = options?.engine
    ? engineConfigToWire(options.engine)
    : model
      ? engineConfigToWire({ kind: 'openai', baseUrl: AI_PROXY_PATH, model })
      : undefined;

  return {
    engineWire,
    proxyUpstream:
      options?.proxyUpstream?.trim() || env.PYRIC_AI_PROXY_UPSTREAM?.trim() || undefined,
  };
}
