/**
 * A page whose HTML pyric never serves, such as a Next.js page under
 * `pyric sandbox -- next dev` or a self-rendering Vite framework in hosted
 * mode, has no stamped `__PYRIC_WORKER_INIT__`. `withPyric` and
 * `pyric({ hosted: true })` inline the selection into the client bundle as
 * `process.env.NEXT_PUBLIC_PYRIC_WORKER_INIT`, and this module declares it as
 * the served HTML stamp would (`runtime/hosted-target.ts`), before
 * `init-payload.ts` reads the page. A stamped page and every other bundler
 * leave it alone.
 */
import type { WorkerInitPayload } from '../init-payload.js';

/** The bundler replaces the whole expression; without it, `process` may not exist. */
function inlinedSelection(): string | undefined {
  try {
    return process.env.NEXT_PUBLIC_PYRIC_WORKER_INIT;
  } catch {
    return undefined;
  }
}

function declareHostedSandbox(projectKey: string | null | undefined): void {
  const meta = document.createElement('meta');
  meta.name = 'pyric-sandbox-host';
  meta.content = 'node';
  if (typeof projectKey === 'string' && projectKey.length > 0) {
    meta.setAttribute('data-project-key', projectKey);
  }
  meta.setAttribute('data-pyric-serve', '');
  document.head.append(meta);
}

const isPage = typeof document !== 'undefined';
const isUnstamped = isPage && globalThis.__PYRIC_WORKER_INIT__ === undefined;
const selection = isUnstamped ? inlinedSelection() : undefined;
if (selection !== undefined) {
  const payload = JSON.parse(selection) as WorkerInitPayload;
  globalThis.__PYRIC_WORKER_INIT__ = payload;
  if (payload.hosted === true) declareHostedSandbox(payload.projectKey);
}
