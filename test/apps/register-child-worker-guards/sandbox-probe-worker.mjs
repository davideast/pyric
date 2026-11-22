import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort } from 'node:worker_threads';

const realAdminAppUrl = pathToFileURL(resolve('node_modules/firebase-admin/lib/esm/app/index.js')).href;

let swapped = false;
let adminError = null;
try {
  const adminApp = await import('firebase-admin/app');
  swapped = adminApp.ADMIN_APP_TARGET === Symbol.for('pyric.admin.app.target');
} catch (error) {
  adminError = error?.code ?? error?.message ?? 'error';
}

let directStopCode = 'loaded';
try {
  await import(realAdminAppUrl);
} catch (error) {
  directStopCode = error?.code ?? error?.message ?? 'error';
}

parentPort?.postMessage({
  swapped,
  adminError,
  directStopCode,
  sandboxEnv: process.env.PYRIC_SANDBOX ?? null,
  instanceEnv: process.env.PYRIC_SANDBOX_INSTANCE ?? null,
  sessionEnv: process.env.PYRIC_SESSION_TOKEN ?? null,
  guardAllowEnv: process.env.PYRIC_GUARD_ALLOW ?? null,
  sandboxActive: globalThis[Symbol.for('pyric.register.active')] === true,
  liveActive: globalThis[Symbol.for('pyric.register.live.active')] === true,
});
