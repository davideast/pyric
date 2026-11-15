import { parentPort } from 'node:worker_threads';

let functionsOutcome = 'loaded';
try {
  await import('firebase/functions');
} catch (error) {
  functionsOutcome = error?.code ?? error?.message ?? 'error';
}
parentPort?.postMessage({
  functionsOutcome,
  liveActive: globalThis[Symbol.for('pyric.register.live.active')] === true,
  sandboxActive: globalThis[Symbol.for('pyric.register.active')] === true,
});
