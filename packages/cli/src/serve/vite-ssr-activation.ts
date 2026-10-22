/**
 * The in-process activation the Vite plugin installs for server-rendered
 * modules (#1123).
 *
 * Under `vite dev` the plugin routes `firebase/*` and `firebase-admin/*` in
 * server-rendered modules to the same modules a `node --import
 * @pyric/cli/register` process gets under `PYRIC_SANDBOX=remote` (#1082): the
 * Node client and `pyric-admin`. Those find their host through the process's
 * activation. A dev server process has no `PYRIC_SANDBOX`, so it installs one
 * here: the host is this dev server's own HTTP server, dialed over loopback
 * as any other Node client dials it, so its calls take the host's sessions,
 * rules, ordering and Studio activity.
 *
 * A SharedWorker dev server installs the same activation. Its `init.json`
 * says it is not the Node host, so each client call fails with the refusal
 * below, and `firebase-admin` refuses at its first call without dialing.
 *
 * One activation serves the process. A Vite restart builds the next server
 * before closing the old one, so the newest server is the one in force, and
 * closing a replaced server changes nothing. Closing the server in force
 * removes the activation, and the Node client stops holding the process, so
 * a process that created the server through Vite's API can end on its own.
 *
 * `firebase-admin`'s app lives as long as the process (its registry is
 * process-wide, as firebase-admin's is), so it gets one connection handle for
 * the process, which dials the server in force at each connect. Closing a
 * server leaves the handle open: an idle handle holds nothing, and the next
 * dev server this process creates is reached by the same app.
 *
 * A dev server that serves HTTPS (`server.https`, often a self-signed
 * certificate) is dialed over https and wss. Those dials trust the server's
 * own certificate, read from `server.https.cert`, and only for its origin
 * (`../remote/loopback-tls.ts`); the process's TLS verification is otherwise
 * untouched. A server whose certificate cannot be read that way is refused,
 * naming HTTPS.
 */
import type { AddressInfo } from 'node:net';
import type { ViteDevServer } from 'vite';
import { FirebaseError } from 'pyric/app';
import type { Sandbox } from 'pyric/sandbox';
import {
  clearProcessActivation,
  installProcessActivation,
  type HostTrust,
  type ProcessActivation,
} from 'pyric/sandbox/internal';
import { connectRemoteSandbox, createLazyRemoteSandbox, type LazyRemoteSandbox } from '../remote/index.js';
import { hostTrustFor, isTrustedOrigin } from '../remote/loopback-tls.js';
import { servesHttps } from './vite-https.js';
import { VITE_SSR_ISSUE_URL } from './vite-net-guard.js';

const LABEL = "the Vite dev server's server-rendered modules";

interface ServerInForce {
  readonly server: ViteDevServer;
  readonly hosted: boolean;
  /** Its certificate's trust, read once it listens over HTTPS. */
  trust?: HostTrust;
}

let inForce: ServerInForce | undefined;
let adminSandbox: LazyRemoteSandbox | undefined;

/** The refusal server-rendered calls get from a dev server that does not host the sandbox. */
export function viteSsrRefusal(detail?: string): FirebaseError {
  const reason = detail === undefined ? '' : ` (${detail})`;
  return new FirebaseError(
    'failed-precondition',
    'pyric: firebase/* and firebase-admin/* in server-rendered modules reach the sandbox only when the ' +
      'Vite dev server hosts it: use pyric({ hosted: true }). This dev server runs the sandbox in the ' +
      `browser (SharedWorker), which server code cannot reach${reason}. See ${VITE_SSR_ISSUE_URL}.`,
  );
}

/** The refusal for an HTTPS dev server whose certificate the loopback dial cannot trust. */
export function httpsCertificateRefusal(): FirebaseError {
  return new FirebaseError(
    'failed-precondition',
    'pyric: this Vite dev server serves HTTPS, and server-rendered modules reach it over loopback trusting only ' +
      'its own certificate, which pyric reads from server.https.cert as PEM. This server has none there (a pfx ' +
      `bundle, or a certificate set another way): set server.https.cert and server.https.key, or serve HTTP. See ${VITE_SSR_ISSUE_URL}.`,
  );
}

/** The url a Node client on this machine dials for a server bound to `address`. */
export function loopbackBase(address: AddressInfo, secure = false): string {
  const scheme = secure ? 'https' : 'http';
  const isWildcard = address.address === '0.0.0.0' || address.address === '::';
  const isIpv6 = address.family === 'IPv6' || (address.family as unknown) === 6;
  if (isWildcard) return `${scheme}://127.0.0.1:${address.port}`;
  const host = isIpv6 ? `[${address.address}]` : address.address;
  return `${scheme}://${host}:${address.port}`;
}

function listeningBase(server: ViteDevServer): Promise<string> {
  const http = server.httpServer;
  if (!http) return Promise.reject(new Error('pyric: the Vite dev server has no HTTP server (middleware mode).'));
  const base = (): string => loopbackBase(http.address() as AddressInfo, servesHttps(server));
  if (http.listening) return Promise.resolve(base());
  return new Promise((resolve) => http.once('listening', () => resolve(base())));
}

/** The trust for the server in force once it listens: null for HTTP, a refusal for HTTPS it cannot trust. */
async function trustFor(current: ServerInForce): Promise<HostTrust | null> {
  const base = await listeningBase(current.server);
  const isPlainHttp = !servesHttps(current.server);
  if (isPlainHttp) return null;
  current.trust ??= hostTrustFor(base, current.server.config?.server?.https) ?? undefined;
  const trust = current.trust;
  if (trust === undefined) throw httpsCertificateRefusal();
  return trust;
}

async function currentHost(): Promise<string> {
  const current = inForce;
  if (current === undefined) throw new Error('pyric: the Vite dev server has closed.');
  await trustFor(current);
  return listeningBase(current.server);
}

function hostTrust(url: string): HostTrust | undefined {
  const trust = inForce?.trust;
  const isCovered = trust !== undefined && isTrustedOrigin(trust, url);
  return isCovered ? trust : undefined;
}

function refusedSandbox(): Sandbox {
  return createLazyRemoteSandbox(() => Promise.reject(viteSsrRefusal()));
}

function hostedSandbox(): Sandbox {
  adminSandbox ??= createLazyRemoteSandbox((onConnectionLost) =>
    currentHost().then((url) => connectRemoteSandbox({ url, trust: hostTrust(url), onConnectionLost })));
  return adminSandbox;
}

const activation: ProcessActivation = {
  label: LABEL,
  host: currentHost,
  offHostError: (detail) => viteSsrRefusal(detail),
  adminSandbox: () => (inForce?.hosted === true ? hostedSandbox() : refusedSandbox()),
  hostTrust,
};

export interface ViteSsrActivation {
  close(): void;
}

/**
 * Activates this process for `server`'s server-rendered modules, unless
 * `PYRIC_SANDBOX` already activates it (`pyric sandbox -- vite`), whose host
 * those modules then reach as any registered process's do.
 */
export function attachViteSsrActivation(
  server: ViteDevServer,
  hosted: boolean,
  env: Record<string, string | undefined> = process.env,
): ViteSsrActivation {
  const isActivatedFromOutside = (env.PYRIC_SANDBOX ?? '').trim().length > 0;
  if (isActivatedFromOutside) return { close: () => {} };
  const attached: ServerInForce = { server, hosted };
  inForce = attached;
  installProcessActivation(activation);
  return {
    close() {
      const isReplaced = inForce !== attached;
      if (isReplaced) return;
      inForce = undefined;
      clearProcessActivation(activation);
    },
  };
}
