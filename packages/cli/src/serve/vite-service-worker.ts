/**
 * The Vite plugin's `serviceWorker` option. In dev, the app's own service
 * worker module gets a fetch listener, ahead of the app's code, that answers
 * production Storage URLs from the sandbox with `pyric/storage/sw`. The helper
 * is imported by an absolute path from Pyric's own install, so the app needs
 * no Pyric import and its production build is untouched.
 */
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServiceWorkerWiringContext {
  /** Vite's resolved root, which a relative `serviceWorker` path is read from. */
  readonly root: string;
  /** Whether this is the dev server; builds and previews are never wired. */
  readonly devServer: boolean;
}

export interface ServiceWorkerWiring {
  /** The wired source of `id`, or null when `id` is not the app's service worker in dev. */
  transform(code: string, id: string, context: ServiceWorkerWiringContext): string | null;
}

function storageFetchListener(): string {
  const helper = fileURLToPath(import.meta.resolve('pyric/storage/sw'));
  return [
    `import { sandboxStorageFetch as __pyricSandboxStorageFetch } from ${JSON.stringify(helper)};`,
    "self.addEventListener('fetch', (event) => {",
    '  if (__pyricSandboxStorageFetch(event)) event.stopImmediatePropagation();',
    '});',
    '',
  ].join('\n');
}

export function createServiceWorkerWiring(serviceWorker: string | undefined): ServiceWorkerWiring {
  return {
    transform(code, id, { root, devServer }) {
      if (serviceWorker === undefined || !devServer) return null;
      const file = (isAbsolute(serviceWorker) ? serviceWorker : resolve(root, serviceWorker)).replaceAll('\\', '/');
      const isServiceWorker = id.split('?')[0] === file;
      if (!isServiceWorker) return null;
      return storageFetchListener() + code;
    },
  };
}
