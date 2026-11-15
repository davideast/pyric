import type { WorkerInitPayload } from '../init-payload.js';
import type { OwnersConfig } from '../owners-config.js';

/** Per-boot session capability token stamped into served HTML or bundled worker init. */
export function stampedSessionToken(): string | undefined {
  const token = (globalThis as { __PYRIC_WORKER_INIT__?: WorkerInitPayload }).__PYRIC_WORKER_INIT__?.sessionToken;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/** Hosted selection is stamped before Studio starts; absence retains SharedWorker. */
export function readHostedTarget(): { url: string; projectKey: string } | null {
  const hasDocument = typeof document !== 'undefined';
  const hasNoDocument = !hasDocument;
  if (hasNoDocument) return null;
  const declaration = document.querySelector('meta[name="pyric-sandbox-host"]');
  const isHosted = declaration?.getAttribute('content') === 'node';
  const isNotHosted = !isHosted;
  if (isNotHosted) return null;
  const projectKey = declaration.getAttribute('data-project-key');
  const hasIdentity = projectKey !== null && projectKey.length > 0;
  const isMissingIdentity = !hasIdentity;
  if (isMissingIdentity) throw new Error('The hosted sandbox has no project identity. Restart the host and reload Studio.');
  const isSecure = location.protocol === 'https:';
  const protocol = isSecure ? 'wss:' : 'ws:';
  return { url: `${protocol}//${location.host}/__pyric/sandbox`, projectKey };
}

/** Optional hosted override when a host declares Node mode without stamping its project path. */
export interface HostedStampOptions {
  hosted?: boolean;
}

/**
 * The page's synchronous transport selection. Served HTML carries it as
 * `__PYRIC_WORKER_INIT__`; a Next.js page or Vite hosted dev bundle, whose HTML
 * pyric may not serve, gets the same value inlined into its client bundle.
 */
export function workerInitPayload(
  projectKey: string | undefined,
  owners?: OwnersConfig,
  instanceId?: string,
  sessionToken?: string,
  options?: HostedStampOptions,
): WorkerInitPayload {
  const hasProjectKey = projectKey !== undefined;
  const hosted = hasProjectKey || options?.hosted === true;
  const payload: WorkerInitPayload = {
    hosted,
    projectKey: hasProjectKey ? projectKey : null,
    bridgeUrl: hasProjectKey ? '/__pyric/sandbox' : null,
  };
  if (owners !== undefined) payload.owners = owners;
  if (hasProjectKey && instanceId !== undefined) payload.instanceId = instanceId;
  if (sessionToken !== undefined && sessionToken.length > 0) payload.sessionToken = sessionToken;
  return payload;
}

export function stampHostedTarget(
  html: string,
  projectKey: string | undefined,
  owners?: OwnersConfig,
  instanceId?: string,
  sessionToken?: string,
  options?: HostedStampOptions,
): string {
  const hasProjectKey = projectKey !== undefined;
  const hosted = hasProjectKey || options?.hosted === true;
  const payload = workerInitPayload(projectKey, owners, instanceId, sessionToken, options);
  const serialized = JSON.stringify(payload).replaceAll('<', '\\u003c');
  let declaration = `<script data-pyric-worker-init>globalThis.__PYRIC_WORKER_INIT__=${serialized};</script>`;
  if (hosted && hasProjectKey) {
    const escaped = projectKey.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    declaration += `<meta name="pyric-sandbox-host" content="node" data-project-key="${escaped}" data-pyric-serve>`;
  } else if (hosted) {
    declaration += '<meta name="pyric-sandbox-host" content="node" data-pyric-serve>';
  }
  // A built page may carry a different selection than its current server.
  const page = html
    .replace(/<script\b[^>]*data-pyric-worker-init[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<meta name="pyric-sandbox-host"[^>]*data-pyric-serve>/gi, '');
  const hasHead = /<head[^>]*>/i.test(page);
  return hasHead ? page.replace(/<head[^>]*>/i, head => head + declaration) : declaration + page;
}
