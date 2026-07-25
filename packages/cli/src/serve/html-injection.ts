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
export function injectServeTags(
  html: string,
  importMap: Record<string, string> = sdkImportMap(),
  workerVersion?: string,
  forceInPage = false,
): string {
  const marker = 'data-pyric-serve';
  if (html.includes(marker)) return html;
  // A sandbox build already bundles its runtime. Adding the import map and
  // init module would boot a second backend; only the staleness stamp belongs.
  if (html.includes(SANDBOX_BUILD_MARKER)) {
    if (!workerVersion || html.includes('pyric-worker-v')) return html;
    const meta = `<meta name="pyric-worker-v" content="${workerVersion}" ${marker}>`;
    const headTag = html.match(/<head[^>]*>/i);
    if (headTag && headTag.index !== undefined) {
      const at = headTag.index + headTag[0].length;
      return html.slice(0, at) + meta + html.slice(at);
    }
    return meta + html;
  }

  // SharedWorkers survive page reloads, so the page compares this served hash
  // with the worker's baked hash and can offer an explicit worker update.
  const versionMeta = workerVersion
    ? `<meta name="pyric-worker-v" content="${workerVersion}" ${marker}>`
    : '';
  // Bridge mode must select the in-page backend before any application module
  // runs, otherwise the agent and application would use different sandboxes.
  const forceTag = forceInPage
    ? `<script ${marker}>globalThis.__PYRIC_FORCE_INPAGE__=true;</script>`
    : '';
  const tags =
    versionMeta +
    forceTag +
    `<script type="importmap" ${marker}>${JSON.stringify({ imports: importMap })}</script>` +
    `<script type="module" src="/__pyric/sdk/init.js" ${marker}></script>`;
  const head = html.match(/<head[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tags + html.slice(at);
  }
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag && htmlTag.index !== undefined) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + tags + html.slice(at);
  }
  return tags + html;
}
