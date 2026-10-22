/**
 * The client SDK bootstrap for a Node process `@pyric/cli/register` activated
 * against a remote host (#1082).
 *
 * Under `PYRIC_SANDBOX=remote`, `remote:<url>`, `1` or `true`, the register
 * mapping resolves `firebase/app`, `firebase/database`, `firebase/firestore`,
 * `firebase/auth` and `firebase/storage` to the modules beside this one. Each
 * imports this module first, so before any served entry evaluates:
 *
 * - the host is resolved as `remoteSandbox()` resolves it for `pyric-admin`
 *   (`PYRIC_SANDBOX_INSTANCE`, the stale-url check, `.pyric/serve.json`), at
 *   the first call that needs it;
 * - the served entries get a Node runtime origin: `init.json` and the socket
 *   on that host, the `ws` realm (`./node-realm.ts`), and the refusal every
 *   call gets when the host is not the Node host;
 * - the app registry is bound to a refusal instead of a sandbox, so a service
 *   with no path to the host (`firebase/ai`, `firebase/messaging`) fails at its
 *   first call and nothing falls back to an in-process sandbox.
 *
 * A host running in this process (the Vite plugin's dev server, #1123)
 * installs an in-process activation instead of `PYRIC_SANDBOX`; when the
 * variable is unset, the host, the off-host error and the refusal come from
 * that activation, read at each use so a restarted dev server's replaces the old.
 *
 * Nothing here sets or reads `location`, `window` or `document`.
 */
import { bindAppRegistryRefusal, clientSdkRefusal, clientSdkRefusalFor } from 'pyric/app/internal';
import {
  onProcessActivationEnd,
  parsePyricSandbox,
  processActivation,
  type ProcessActivation,
} from 'pyric/sandbox/internal';
import { installNodeRuntimeOrigin } from '../../serve/entries/runtime-origin.js';
import { resolveRemoteHost } from '../../remote/resolve-host.js';
import { versionSkewGuidance } from '../../remote/version-skew.js';
import { createNodeSocketRealm } from './node-realm.js';
import { offHostRefusal } from './off-host-refusal.js';

/** The in-process activation, when `PYRIC_SANDBOX` does not activate this process. */
function inProcessActivation(): ProcessActivation | undefined {
  const setting = process.env.PYRIC_SANDBOX ?? '';
  const isEnvUnset = setting.trim().length === 0;
  return isEnvUnset ? processActivation() : undefined;
}

function resolveHost(): Promise<string> {
  const activation = parsePyricSandbox(process.env.PYRIC_SANDBOX);
  const configuredUrl = activation.mode === 'remote' ? activation.url : undefined;
  return resolveRemoteHost({
    cwd: process.cwd(),
    configuredUrl,
    instanceId: process.env.PYRIC_SANDBOX_INSTANCE,
  }).then(({ wsBase }) => wsBase);
}

let skewReported = false;

function reportVersionSkew(serveVersion: unknown): void {
  if (skewReported) return;
  const guidance = versionSkewGuidance(serveVersion, 'Restart pyric sandbox and rerun this process.');
  if (guidance === null) return;
  skewReported = true;
  process.stderr.write(`pyric: ${guidance}\n`);
}

let host: Promise<string> | undefined;

/**
 * Resolves the host at the first call that needs it, and keeps the answer
 * once one is found. A failed discovery is not kept: a process started before
 * its host finds it at a later call, as firebase-admin does. An in-process
 * activation is asked each time: it answers from the dev server in force.
 */
function hostOnce(): Promise<string> {
  const inProcess = inProcessActivation();
  if (inProcess !== undefined) return inProcess.host();
  if (host === undefined) {
    const discovery = resolveHost();
    host = discovery;
    // Each call hears a discovery failure through init.json; this is not one more.
    discovery.catch(() => {
      const isLatest = host === discovery;
      if (isLatest) host = undefined;
    });
  }
  return host;
}

const socketRealm = createNodeSocketRealm({
  onAttached: ack => reportVersionSkew(ack.serveVersion),
  // Only a host in this process can name a certificate to trust, and only for its own origin.
  trust: url => inProcessActivation()?.hostTrust?.(url),
});
// The in-process host ended for good (its dev server closed): let the process go.
onProcessActivationEnd(() => socketRealm.releaseAll());

installNodeRuntimeOrigin({
  realm: 'node',
  host: hostOnce,
  socketRealm,
  offHostError: (detail) => inProcessActivation()?.offHostError(detail) ?? offHostRefusal(detail),
});

const setting = process.env.PYRIC_SANDBOX ?? '';
bindAppRegistryRefusal(() => {
  const inProcess = inProcessActivation();
  return inProcess === undefined ? clientSdkRefusal(setting) : clientSdkRefusalFor(inProcess.label);
});
