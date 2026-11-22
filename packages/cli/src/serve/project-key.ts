import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isLoopbackHostHeader } from './guard-policy.js';
import { getHeader } from './loopback-guard.js';
import { isLocalPeer, REMOTE_PEER_HEADER } from './peer.js';

const OPAQUE_PROJECT_KEY_PREFIX = 'project-';
const OPAQUE_PROJECT_KEY_DOMAIN = 'pyric-project-key:v1:';

/**
 * Derive a deterministic, opaque project key from a local project directory
 * path so non-loopback or remote-Host clients never observe the raw filesystem
 * path (which may embed a developer username) while preserving exact key
 * equality across HTML, `/__pyric/init.json`, and WebSocket `attach-ack`
 * (#1813).
 */
export function opaqueProjectKey(projectKey: string): string {
  const digest = createHash('sha256')
    .update(`${OPAQUE_PROJECT_KEY_DOMAIN}${projectKey}`)
    .digest('hex')
    .slice(0, 24);
  return `${OPAQUE_PROJECT_KEY_PREFIX}${digest}`;
}

/**
 * Shared predicate across HTML, Studio shell, `/__pyric/init.json`, WS
 * `attach-ack`, and `/__pyric/state` matching `evaluateGuard`'s
 * `isRemoteRequest` definition: true whenever the TCP peer is non-loopback,
 * the request carries the remote-peer marker header, or the `Host` header is
 * not a loopback host.
 */
export function isRemoteClientRequest(
  req: Pick<IncomingMessage, 'socket' | 'headers' | 'rawHeaders'>,
): boolean {
  const markedRemote = getHeader(req, REMOTE_PEER_HEADER) !== undefined;
  if (markedRemote || !isLocalPeer(req)) return true;
  return !isLoopbackHostHeader(getHeader(req, 'host'));
}

/**
 * Return the `projectKey` safe to send to a client: unchanged for loopback
 * requests, replaced by a deterministic opaque token for remote requests.
 */
export function clientProjectKey(
  projectKey: string | undefined,
  isRemote: boolean,
): string | undefined {
  if (projectKey === undefined) return undefined;
  return isRemote ? opaqueProjectKey(projectKey) : projectKey;
}
