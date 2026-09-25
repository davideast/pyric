import { REACT_BOOTSTRAP } from './react-bootstrap.js';
import type { ConfigEnv, UserConfig } from 'vite';
import { SANDBOX_BUILD_META } from './sandbox-marker.js';
import {
  loadViteAiEnv,
  resolveViteAiConfig,
  type PyricAiOptions,
  type ResolvedViteAiConfig,
} from './vite-ai-config.js';
import type { ViteWorkerRuntime } from './vite-worker-runtime.js';
import { permitAiUpstreams } from './ai-proxy.js';
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

export interface VitePageRuntime {
  applies(env: ConfigEnv): boolean;
  config(config: UserConfig, env: ConfigEnv): UserConfig;
  ai(): ResolvedViteAiConfig;
  buildStart(emitFile: (chunk: { type: 'chunk'; id: string; name: string }) => string): void;
  generateBundle(getFileName: (referenceId: string) => string): void;
  transformIndexHtml(html: string): string;
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
  let resolvedAi = resolveViteAiConfig(options.ai, {});
  let sandboxBuild = false;
  let initChunkRef: string | undefined;
  let initChunkFile: string | undefined;

  return {
    applies(env) {
      return env.command === 'serve' || swapsInBuild(env, options.swapInBuild);
    },
    config(config, env) {
      sandboxBuild = env.command === 'build';
      const loadedEnv = loadViteAiEnv(env.mode, config.root, config.envDir);
      resolvedAi = resolveViteAiConfig(options.ai, loadedEnv);
      // The Vite dev server is the process `pyric sandbox` guards, and it
      // dials these destinations itself, so its guard must permit them.
      permitAiUpstreams(resolvedAi);
      return sandboxBuild ? { build: { target: 'esnext' } } : {};
    },
    ai() {
      return resolvedAi;
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
      let aiEngineTag = '';
      if (resolvedAi.engineWire) {
        aiEngineTag = `<script ${marker}>globalThis.__PYRIC_AI_ENGINE__=${JSON.stringify(resolvedAi.engineWire).replace(/</g, '\\u003c')};</script>`;
      }
      const tag = REACT_BOOTSTRAP + head + aiEngineTag + runtimeChipTag +
        `<script type="module" src="/@fs/${initEntry}" ${marker}></script>`;
      return injectIntoHead(html, tag);
    },
  };
}
