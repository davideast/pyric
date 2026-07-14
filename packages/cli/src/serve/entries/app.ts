/** Served `firebase/app`: the exact Pyric client registry over the page runtime. */
import { bindAppRegistrySandbox } from 'pyric/app/internal';
import { sandbox } from './app-backend.js';

// Keep this entry free of dynamic imports: ServiceWorkerGlobalScope supports
// static module imports but rejects dynamic import(). The attached sandbox is
// only the app handle's realm-local placeholder; served service calls route to
// the SharedWorker (directly in Window, via BroadcastChannel in a real SW).
bindAppRegistrySandbox(sandbox);

export * from 'pyric/app';
