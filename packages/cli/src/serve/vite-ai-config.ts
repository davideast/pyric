import type { AIOptions } from 'pyric/ai';
import { GEMINI_SERVER_KEYS } from 'pyric/ai/internal';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import type { AiEngineConfigWire } from './worker/protocol.js';
import { resolveAiMode } from './firebase-module-swap.js';

export { browserAiEngineWire } from './ai-engine-wire.js';

const AI_PROXY_PATH = '/__pyric/ai-proxy';

/** Declarative AI engines that can cross Vite's page/SharedWorker boundary. */
export type PyricAiEngineConfig = Extract<NonNullable<AIOptions['engine']>, { kind: string }>;

export interface PyricAiOptions {
  /** Mode for AI Logic: 'sandbox' (local mirrors) or 'production' (`firebase/ai` is the Firebase SDK, calling Google AI or Vertex AI with the app's config). Overrides `PYRIC_AI_MODE`. */
  mode?: 'sandbox' | 'production';
  /** Simple OpenAI-compatible model selection through Pyric's same-origin proxy. */
  model?: string;
  /** Advanced declarative engine configuration. */
  engine?: PyricAiEngineConfig;
  /** OpenAI-compatible upstream: reached directly by Node, or through the browser proxy. */
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

function copyProcessEnvStrings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined) {
      out[key] = val;
    }
  }
  return out;
}

function dotEnvFilenames(mode: string): string[] {
  const names = ['.env'];
  if (mode !== 'test') {
    names.push('.env.local');
  }
  if (mode.length > 0) {
    names.push(`.env.${mode}`);
    names.push(`.env.${mode}.local`);
  }
  return names;
}

function loadDotEnvFiles(mode: string, envDir: string): Record<string, string> {
  const loaded: Record<string, string> = {};
  for (const filename of dotEnvFilenames(mode)) {
    const filePath = path.join(envDir, filename);
    if (!existsSync(filePath)) continue;
    const parsed = parseEnv(readFileSync(filePath, 'utf8'));
    for (const [key, val] of Object.entries(parsed)) {
      if (val !== undefined) {
        loaded[key] = val;
      }
    }
  }
  for (const [key, val] of Object.entries(copyProcessEnvStrings())) {
    loaded[key] = val;
  }
  return loaded;
}

/** Load env using Vite's `envDir`-relative-to-root convention (`false` disables `.env` files). */
export function loadViteAiEnv(
  mode: string,
  root: string | undefined,
  envDir: string | false | undefined,
): Record<string, string> {
  if (envDir === false) {
    return copyProcessEnvStrings();
  }
  const resolvedRoot = path.resolve(root ?? process.cwd());
  const resolvedEnvDir = envDir === undefined
    ? resolvedRoot
    : path.resolve(resolvedRoot, envDir);
  const loaded = loadDotEnvFiles(mode, resolvedEnvDir);
  for (const [key, val] of Object.entries(loaded)) {
    const isServerGeminiKey = (GEMINI_SERVER_KEYS as readonly string[]).includes(key);
    const isAuthKey = isServerGeminiKey || key === 'PYRIC_API_KEY';
    if (isAuthKey && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
  return loaded;
}

/** The Gemini key name Vite serves to the browser under its default `envPrefix`. */
const BROWSER_SERVED_GEMINI_KEY = 'VITE_GEMINI_API_KEY';

/** Whether `env` carries a non-blank `VITE_GEMINI_API_KEY` (never returns the value). */
export function hasIgnoredBrowserGeminiKey(env: Record<string, string | undefined>): boolean {
  const value = env[BROWSER_SERVED_GEMINI_KEY];
  return value !== undefined && value.trim() !== '';
}
/** Vite's `envPrefix` when the app sets none. */
const DEFAULT_ENV_PREFIX = 'VITE_';

/** The app's `envPrefix` as Vite resolves it: a list, `VITE_` when unset. */
function envPrefixList(envPrefix: string | string[] | undefined): string[] {
  if (envPrefix === undefined) return [DEFAULT_ENV_PREFIX];
  if (typeof envPrefix === 'string') return [envPrefix];
  return envPrefix;
}

/** The prefix that makes Vite serve `name` to the browser, or `undefined` when none does. */
function servingPrefix(name: string, prefixes: string[]): string | undefined {
  return prefixes.find((prefix) => name.startsWith(prefix));
}

/** What to do about a key in `name`, which Vite serves because of `prefix`. */
function refusalAdvice(name: string, prefix: string, prefixes: string[]): string {
  const serverName = GEMINI_SERVER_KEYS.find((key) => key !== name && servingPrefix(key, prefixes) === undefined);
  if (serverName === undefined) {
    return `Change envPrefix in your Vite config so it does not cover ${GEMINI_SERVER_KEYS.join(' or ')}, then put the key in GEMINI_API_KEY. Pyric's dev server reads GEMINI_API_KEY and keeps it on the server.`;
  }
  const keepsIt = `Pyric's dev server reads ${serverName} and keeps it on the server.`;
  const isServerName = (GEMINI_SERVER_KEYS as readonly string[]).includes(name);
  if (isServerName) {
    return `Remove ${prefix} from envPrefix in your Vite config, or rename the key to ${serverName} in your environment or .env file. ${keepsIt}`;
  }
  return `Rename it to ${serverName} in your environment or .env file. ${keepsIt}`;
}

/**
 * Refuse a dev server whose environment or `.env` holds a Gemini key that
 * Vite would serve to the browser: `VITE_GEMINI_API_KEY`, or a name the
 * gemini engine reads, whenever the app's `envPrefix` covers it. Vite serves
 * every variable whose name starts with an `envPrefix` entry, so the key
 * would reach every page the dev server serves (#1632, #1659). `env` is what
 * `loadViteAiEnv` returned, which includes the shell's environment, and
 * `envPrefix` is the resolved config's. A blank value holds no key and is
 * left alone, and the message never quotes the key.
 */
export function refuseBrowserServedGeminiKey(
  env: Record<string, string | undefined>,
  envPrefix?: string | string[],
): void {
  const prefixes = envPrefixList(envPrefix);
  for (const name of [BROWSER_SERVED_GEMINI_KEY, ...GEMINI_SERVER_KEYS]) {
    const prefix = servingPrefix(name, prefixes);
    if (prefix === undefined) continue;
    const value = env[name];
    const holdsKey = value !== undefined && value.trim() !== '';
    if (!holdsKey) continue;
    throw new Error(
      `@pyric/cli/vite: ${name} is set. Vite serves every variable whose name starts with ${prefix} to the browser, so this key would reach every page the dev server serves. ${refusalAdvice(name, prefix, prefixes)}`,
    );
  }
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

/** Resolve explicit AI options (`pyric.json` or Vite plugin) over environment variables. */
export function resolveViteAiConfig(
  options: PyricAiOptions | undefined,
  env: Record<string, string | undefined>,
  sourceLabel = '@pyric/cli/vite',
): ResolvedViteAiConfig {
  const explicitModel = options?.model;
  const explicitEngine = options?.engine;
  const hasModelOption = explicitModel !== undefined;
  const hasEngineOption = explicitEngine !== undefined;
  const hasBothModelAndEngine = hasModelOption && hasEngineOption;
  if (hasBothModelAndEngine) {
    throw new Error(`${sourceLabel}: Choose either ai.model or ai.engine, not both.`);
  }

  const mode = resolveAiMode(options?.mode, env);
  const isProductionMode = mode === 'production';
  const hasAnyEngineConfig = hasModelOption || hasEngineOption;
  const isInvalidProductionConfig = isProductionMode && hasAnyEngineConfig;
  if (isInvalidProductionConfig) {
    throw new Error(`${sourceLabel}: Cannot configure ai.model or ai.engine when ai.mode is set to "production".`);
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

  // Production mode has no engine: `firebase/ai` is the Firebase SDK, which
  // calls Google AI or Vertex AI with the app's own config.
  let engineWire: AiEngineConfigWire | undefined = undefined;
  if (isProductionMode) {
    engineWire = undefined;
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
