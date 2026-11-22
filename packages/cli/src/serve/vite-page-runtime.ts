import { realpathSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { REACT_BOOTSTRAP } from './react-bootstrap.js';
import type { ConfigEnv, ResolvedConfig, UserConfig } from 'vite';
import { workerInitPayload } from './runtime/hosted-target.js';
import { SANDBOX_BUILD_META } from './sandbox-marker.js';
import {
  browserAiEngineWire,
  hasIgnoredBrowserGeminiKey,
  loadViteAiEnv,
  refuseBrowserServedGeminiKey,
  resolveViteAiConfig,
  type PyricAiOptions,
  type ResolvedViteAiConfig,
} from './vite-ai-config.js';
import type { ViteWorkerRuntime } from './vite-worker-runtime.js';
import {
  PYRIC_RUNTIME_CHIP_META,
  runtimeChipMetaValue,
  type PyricRuntimeChipOption,
} from './runtime/chip-config.js';

export interface VitePageRuntimeOptions {
  hosted?: boolean;
  runtimeChip?: PyricRuntimeChipOption;
  swapInBuild?: boolean;
  ai?: PyricAiOptions;
}

interface VitePageRuntimeResolvedInput {
  mode?: string;
  root?: string;
  envDir?: string | false;
  envPrefix?: string | string[];
  define?: Record<string, unknown>;
  command?: ResolvedConfig['command'];
  isPreview?: boolean;
}

export interface VitePageRuntime {
  applies(env: ConfigEnv): boolean;
  config(config: UserConfig, env: ConfigEnv): UserConfig;
  configResolved(resolved: VitePageRuntimeResolvedInput): void;
  ai(): ResolvedViteAiConfig;
  hasIgnoredGeminiKey(): boolean;
  buildStart(emitFile: (chunk: { type: 'chunk'; id: string; name: string }) => string): void;
  generateBundle(getFileName: (referenceId: string) => string): void;
  transformModule(code: string, id: string): string | null;
  transformIndexHtml(html: string): string;
}

const WORKER_INIT_DEFINE_KEY = 'process.env.NEXT_PUBLIC_PYRIC_WORKER_INIT';
const WORKER_INIT_REPLACE_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|\bprocess\.env\.NEXT_PUBLIC_PYRIC_WORKER_INIT\b/g;

function isBundledWorkerInitId(cleanId: string, expectedPath: string): boolean {
  if (cleanId === expectedPath) return true;
  const hasEntryName =
    cleanId.endsWith('/bundled-worker-init.js') ||
    cleanId.endsWith('/bundled-worker-init.ts') ||
    cleanId.endsWith('\\bundled-worker-init.js') ||
    cleanId.endsWith('\\bundled-worker-init.ts');
  if (!hasEntryName) return false;
  try {
    return realpathSync(cleanId) === realpathSync(expectedPath);
  } catch {
    return false;
  }
}

function swapsInBuild(env: ConfigEnv, override: boolean | undefined): boolean {
  return override ?? env.mode !== 'production';
}

/**
 * Put pyric's tags ahead of the page's own scripts.
 *
 * The synchronous React hook bootstrap must precede application modules.
 * The remaining sandbox init can wait for its asynchronous dependencies without
 * missing React's renderer registration. Builds can put app scripts in the
 * head, so appending the bootstrap at the end of the head would be too late.
 */
function injectIntoHead(html: string, tags: string): string {
  const headEnd = html.indexOf('</head>');
  const scanEnd = headEnd === -1 ? html.length : headEnd;
  const firstScript = html.slice(0, scanEnd).search(/<script[\s>]/i);
  if (firstScript >= 0) return html.slice(0, firstScript) + tags + html.slice(firstScript);
  if (headEnd >= 0) return html.slice(0, headEnd) + tags + html.slice(headEnd);
  return tags + html;
}

/** Own build-generation and served-page state for one plugin instance. */
export function createVitePageRuntime(input: {
  options: VitePageRuntimeOptions;
  studioEnabled: boolean;
  initEntry: string;
  workerRuntime: ViteWorkerRuntime;
}): VitePageRuntime {
  const { options, studioEnabled, initEntry, workerRuntime } = input;
  let initExt = extname(initEntry);
  if (initExt.length === 0) initExt = '.js';
  const bundledWorkerInitEntry = join(dirname(initEntry), `bundled-worker-init${initExt}`);
  let resolvedAi = resolveViteAiConfig(options.ai, process.env);
  let sandboxBuild = false;
  let initChunkRef: string | undefined;
  let initChunkFile: string | undefined;
  let pendingMode = 'development';
  let pendingRoot: string | undefined;
  let pendingEnvDir: string | false | undefined;
  let isDevServerMode = false;
  let ignoredGeminiKey = hasIgnoredBrowserGeminiKey(process.env);
  /**
   * Vite skips `vite:define` transforms on dev client modules, injecting `define`
   * only through `/@vite/client`. Mirror the resolved worker-init define into
   * `bundled-worker-init` during dev so self-rendering pages initialize even
   * without `/@vite/client`.
   */
  let devWorkerInitDefine: string | undefined;

  return {
    applies(env) {
      return env.command === 'serve' || swapsInBuild(env, options.swapInBuild);
    },
    config(config, env) {
      const isBuild = env.command === 'build';
      const isSsrBuild = env.isSsrBuild === true || Boolean(config.build?.ssr);
      sandboxBuild = isBuild && !isSsrBuild;
      const isDevServer = env.command === 'serve' && env.isPreview !== true;
      isDevServerMode = isDevServer;
      pendingMode = env.mode;
      pendingRoot = config.root;
      pendingEnvDir = config.envDir;
      resolvedAi = resolveViteAiConfig(options.ai, process.env);
      ignoredGeminiKey = hasIgnoredBrowserGeminiKey(process.env);
      if (isBuild) return { build: { target: 'esnext' } };
      // Frameworks that render their own dev HTML (such as Astro) bypass
      // `transformIndexHtml`. Define a non-sensitive hosted marker in dev
      // client bundles so swapped SDK modules discover `/__pyric/init.json`
      // without embedding the local project path.
      const definesHostedFallback = isDevServer && options.hosted === true;
      const hasUserWorkerInit =
        config.define !== undefined &&
        Object.prototype.hasOwnProperty.call(config.define, WORKER_INIT_DEFINE_KEY) &&
        config.define[WORKER_INIT_DEFINE_KEY] !== undefined;
      if (definesHostedFallback && !hasUserWorkerInit) {
        const selection = JSON.stringify(
          workerInitPayload(undefined, undefined, undefined, undefined, { hosted: true }),
        );
        return {
          define: {
            [WORKER_INIT_DEFINE_KEY]: JSON.stringify(selection),
          },
        };
      }
      return {};
    },
    configResolved(resolved) {
      // Load `.env` files in `configResolved` so Pyric reads from the finalized
      // `mode`, `root`, `envDir`, and `envPrefix` after every plugin's `config` hook (#1743).
      let mode = pendingMode;
      if (resolved.mode !== undefined) {
        mode = resolved.mode;
      }
      let root = pendingRoot;
      if (resolved.root !== undefined) {
        root = resolved.root;
      }
      let envDir = pendingEnvDir;
      if (resolved.envDir !== undefined) {
        envDir = resolved.envDir;
      }
      let devServer = isDevServerMode;
      if (resolved.command !== undefined) {
        devServer = resolved.command === 'serve' && resolved.isPreview !== true;
      }
      const loadedEnv = loadViteAiEnv(mode, root, envDir);
      resolvedAi = resolveViteAiConfig(options.ai, loadedEnv);
      ignoredGeminiKey = hasIgnoredBrowserGeminiKey(loadedEnv);
      if (!devServer) {
        devWorkerInitDefine = undefined;
        return;
      }
      const rawDefine = resolved.define?.[WORKER_INIT_DEFINE_KEY];
      if (typeof rawDefine === 'string') {
        devWorkerInitDefine = rawDefine;
      } else if (rawDefine !== undefined) {
        devWorkerInitDefine = JSON.stringify(rawDefine);
      } else {
        devWorkerInitDefine = undefined;
      }
      refuseBrowserServedGeminiKey(loadedEnv, resolved.envPrefix);
    },
    ai() {
      return resolvedAi;
    },
    hasIgnoredGeminiKey() {
      return ignoredGeminiKey;
    },
    buildStart(emitFile) {
      if (!sandboxBuild) return;
      initChunkRef = emitFile({
        type: 'chunk',
        id: initEntry,
        name: 'pyric-sandbox-init',
      });
    },
    generateBundle(getFileName) {
      if (initChunkRef) initChunkFile = getFileName(initChunkRef);
    },
    transformModule(code, id) {
      const replacement = devWorkerInitDefine;
      if (replacement === undefined) return null;
      const cleanId = id.split('?')[0] ?? id;
      if (!isBundledWorkerInitId(cleanId, bundledWorkerInitEntry)) return null;
      if (!code.includes(WORKER_INIT_DEFINE_KEY)) return null;
      return code.replace(WORKER_INIT_REPLACE_RE, (match) => {
        if (match === WORKER_INIT_DEFINE_KEY) return replacement;
        return match;
      });
    },
    transformIndexHtml(html) {
      const marker = 'data-pyric-sandbox';
      const runtimeChipTag = `<meta name="${PYRIC_RUNTIME_CHIP_META}" content="${runtimeChipMetaValue(options.runtimeChip)}" data-studio="${studioEnabled ? 'on' : 'off'}" ${marker}>`;
      if (sandboxBuild) {
        if (html.includes(SANDBOX_BUILD_META)) return html;
        let initTag = '';
        if (initChunkFile) {
          initTag = `<script type="module" crossorigin src="/${initChunkFile}" data-pyric-sandbox-init></script>`;
        }
        const tags = REACT_BOOTSTRAP + SANDBOX_BUILD_META + runtimeChipTag + initTag;
        return injectIntoHead(html, tags);
      }
      if (html.includes(marker)) return html;
      const head = options.hosted ? '' : workerRuntime.headTag(marker);
      const browserEngine = browserAiEngineWire(resolvedAi.engineWire);
      let aiEngineTag = '';
      if (browserEngine) {
        aiEngineTag = `<script ${marker}>globalThis.__PYRIC_AI_ENGINE__=${JSON.stringify(browserEngine).replace(/</g, '\\u003c')};</script>`;
      }
      const tag = REACT_BOOTSTRAP + head + aiEngineTag + runtimeChipTag +
        `<script type="module" src="/@fs/${initEntry}" ${marker}></script>`;
      return injectIntoHead(html, tag);
    },
  };
}
