// The process that holds a run's sandbox open. `namespace.ts` starts it as
// the sandbox's command, after the catch-all routes are in place, and enters
// the sandbox through bwrap's child pid while it runs. It starts the
// resolver (`dns-log.mjs`) and the catch-all listener (`catch-all-log.mjs`),
// both recording to PYRIC_BUILDER_NETWORK_LOG, prints `{"ready":true}` once
// both are bound, and exits when its stdin closes or on SIGTERM.
import { serveCatchAll } from './catch-all-log.mjs';
import { serveDns } from './dns-log.mjs';

const logPath = process.env.PYRIC_BUILDER_NETWORK_LOG;
if (!logPath) throw new Error('PYRIC_BUILDER_NETWORK_LOG is not set');

const resolver = await serveDns(logPath);
const listeners = await serveCatchAll(logPath);
console.log(JSON.stringify({ ready: true }));

const stop = () => {
  for (const listener of listeners) listener.close();
  resolver.close(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.stdin.once('end', stop);
process.stdin.resume();
