/**
 * Where a Node process's socket goes when it reattaches to a host that may
 * have moved. Discovery reads `.pyric/serve.json` in this project and its
 * parent and sibling folders, and a host removes its pointer when it stops,
 * so while this project's host restarts, discovery can answer with a
 * neighbouring project's host or with a host that is not the Node host.
 * Attaching there closes the client for good, so the url is refused instead
 * and the reattach tries again on its backoff until this project's host is back.
 */
import type { InitPayload } from '../init-payload.js';
import { toPageOriginWsUrl } from './bridge-url.js';
import { hostLocation } from './runtime-origin.js';

/** The host a Node process attached to first: its project and its socket path. */
export interface AttachedHost {
  readonly projectKey: string;
  readonly bridgeUrl: string;
}

/** The socket url on `host`, whose `init.json` is `current`, or a throw while `host` is not this project's Node host. */
export function movedSocketUrl(current: InitPayload, host: string, attached: AttachedHost): string {
  const isOtherProject = current.projectKey !== attached.projectKey;
  if (isOtherProject) throw new Error(`The host at ${host} serves another project; waiting for this project's host.`);
  const isNotNodeHost = current.hosted !== true;
  if (isNotNodeHost) throw new Error(`The host at ${host} is not the Node host; waiting for this project's host.`);
  const bridgeUrl = typeof current.bridgeUrl === 'string' ? current.bridgeUrl : attached.bridgeUrl;
  return toPageOriginWsUrl(bridgeUrl, hostLocation(host), 'page-origin');
}
