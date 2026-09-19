import { stampHostedTarget } from './runtime/hosted-target.js';
import { REACT_BOOTSTRAP } from './react-bootstrap.js';
import { SANDBOX_BUILD_MARKER } from './sandbox-marker.js';

/** The import-map targets. Spec → served URL. */
export function sdkImportMap(options?: { aiMode?: 'sandbox' | 'production' }): Record<string, string> {
  const explicitMode = options?.aiMode;
  let mode: 'sandbox' | 'production' = 'sandbox';
  const hasExplicitMode = explicitMode !== undefined;
  if (hasExplicitMode) {
    mode = explicitMode;
  } else {
    const isEnvProductionMode = process.env.PYRIC_AI_MODE === 'production';
    const isEnvPassthroughFlag = process.env.PYRIC_AI_PASSTHROUGH === '1';
    const isProductionEnv = isEnvProductionMode || isEnvPassthroughFlag;
    if (isProductionEnv) {
      mode = 'production';
    }
  }
  const isProductionMode = mode === 'production';
  if (isProductionMode) {
    return {
      'firebase/app': '/__pyric/sdk/app-ai-passthrough.js',
      'firebase/auth': '/__pyric/sdk/auth.js',
      'firebase/database': '/__pyric/sdk/database.js',
      'firebase/firestore': '/__pyric/sdk/firestore.js',
      'firebase/messaging': '/__pyric/sdk/messaging.js',
      'firebase/messaging/sw': '/__pyric/sdk/messaging-sw.js',
      'firebase/storage': '/__pyric/sdk/storage.js',
    };
  }
  return {
    'firebase/ai': '/__pyric/sdk/ai.js',
    'firebase/app': '/__pyric/sdk/app.js',
    'firebase/auth': '/__pyric/sdk/auth.js',
    'firebase/database': '/__pyric/sdk/database.js',
    'firebase/firestore': '/__pyric/sdk/firestore.js',
    'firebase/messaging': '/__pyric/sdk/messaging.js',
    'firebase/messaging/sw': '/__pyric/sdk/messaging-sw.js',
    'firebase/storage': '/__pyric/sdk/storage.js',
  };
}

/** Inject the sandbox import map and boot tags before application modules. */
export interface ServeTagOptions {
  importMap?: Record<string, string>;
  workerVersion?: string;
  forceInPage?: boolean;
  hosted?: { projectKey: string };
}

export function injectServeTags(html: string, options: ServeTagOptions = {}): string {
  return stampHostedTarget(injectRuntimeTags(html, options), options.hosted?.projectKey);
}

function injectRuntimeTags(html: string, options: ServeTagOptions): string {
  const importMap = options.importMap ?? sdkImportMap();
  const { workerVersion, forceInPage = false } = options;
  const marker = 'data-pyric-serve';
  const isAlreadyInjected = html.includes(marker);
  if (isAlreadyInjected) return html;
  // A sandbox build already bundles its runtime. Adding the import map and
  // init module would boot a second backend; only the staleness stamp belongs.
  const isSandboxBuild = html.includes(SANDBOX_BUILD_MARKER);
  const hasWorkerVersion = Boolean(workerVersion);
  if (isSandboxBuild) {
    const needsVersionStamp = hasWorkerVersion && !html.includes('pyric-worker-v');
    const hasReactBootstrap = html.includes('data-pyric-react-hook');
    let meta = (hasReactBootstrap ? '' : REACT_BOOTSTRAP);
    if (needsVersionStamp) meta += `<meta name="pyric-worker-v" content="${workerVersion}" ${marker}>`;
    const hasNoRuntimeStamp = meta.length === 0;
    if (hasNoRuntimeStamp) return html;
    const headTag = /<head[^>]*>/i.exec(html);
    const hasHeadTag = headTag !== null;
    if (hasHeadTag) {
      const at = headTag.index + headTag[0].length;
      return html.slice(0, at) + meta + html.slice(at);
    }
    return meta + html;
  }

  // SharedWorkers survive page reloads, so the page compares this served hash
  // with the worker's baked hash and can offer an explicit worker update.
  const versionMeta = hasWorkerVersion
    ? `<meta name="pyric-worker-v" content="${workerVersion}" ${marker}>`
    : '';
  // Bridge mode must select the in-page backend before any application module
  // runs, otherwise the agent and application would use different sandboxes.
  const forceTag = forceInPage
    ? `<script ${marker}>globalThis.__PYRIC_FORCE_INPAGE__=true;</script>`
    : '';
  const tags =
    REACT_BOOTSTRAP +
    versionMeta +
    forceTag +
    `<script type="importmap" ${marker}>${JSON.stringify({ imports: importMap })}</script>` +
    `<script type="module" src="/__pyric/sdk/init.js" ${marker}></script>`;
  const head = /<head[^>]*>/i.exec(html);
  const hasHead = head !== null;
  if (hasHead) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tags + html.slice(at);
  }
  const htmlTag = /<html[^>]*>/i.exec(html);
  const hasHtmlTag = htmlTag !== null;
  if (hasHtmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + tags + html.slice(at);
  }
  return tags + html;
}
