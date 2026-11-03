/**
 * The address the served copy's port listens on, from
 * `PYRIC_FACTORY_SERVE_HOST`: this machine's loopback unless the operator
 * names one address of its own, such as its address on a private network,
 * so another device there can open the served copy and its status page.
 * It must be one IP address: a host name could resolve anywhere, and a
 * wildcard address would listen on every network, public ones included.
 * Pyric's WebSocket port stays on loopback whatever this says.
 */
import { isIP } from 'node:net';

export const LOOPBACK = '127.0.0.1';

export class ServeHostInvalid extends Error {}

/** The address in the form a URL's host takes it: IPv6 in brackets. */
export function hostInUrl(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

/**
 * The URL parser writes an IPv6 address in its shortest form, so these are
 * `::` and its IPv4-mapped form `::ffff:0.0.0.0` in any spelling. Binding
 * either listens on every network.
 */
const WILDCARD_V6 = new Set(['[::]', '[::ffff:0:0]']);

/** The IPv6 address in its shortest form, as the URL parser writes it, in brackets. */
function shortestV6(address: string): string {
  return new URL(`http://[${address}]/`).hostname;
}

/** `0.0.0.0`, `::` or `::ffff:0.0.0.0`, in any spelling. */
function isWildcard(address: string): boolean {
  if (isIP(address) === 4) return address === '0.0.0.0';
  return WILDCARD_V6.has(shortestV6(address));
}

export function isLoopback(address: string): boolean {
  const isLoopbackV4 = isIP(address) === 4 && address.startsWith('127.');
  const isLoopbackV6 = isIP(address) === 6 && shortestV6(address) === '[::1]';
  return isLoopbackV4 || isLoopbackV6;
}

export function serveHost(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.PYRIC_FACTORY_SERVE_HOST;
  if (value === undefined || value === '') return LOOPBACK;
  const isAddress = isIP(value) !== 0;
  if (!isAddress) throw new ServeHostInvalid(`PYRIC_FACTORY_SERVE_HOST must be one IP address, not ${value}`);
  const hasZone = value.includes('%');
  if (hasZone) {
    throw new ServeHostInvalid(`PYRIC_FACTORY_SERVE_HOST must be an address without a zone id, not ${value}`);
  }
  if (isWildcard(value)) {
    throw new ServeHostInvalid(`PYRIC_FACTORY_SERVE_HOST must name one address, not ${value}, which listens on every network`);
  }
  return value;
}

/** Why `PYRIC_FACTORY_SERVE_HOST` can't be served on, for the harness commands to refuse before a run starts. */
export function serveHostProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    serveHost(env);
    return undefined;
  } catch (error) {
    if (!(error instanceof ServeHostInvalid)) throw error;
    return error.message;
  }
}

/** The host names Next and Pyric must accept from a page: the private network's name and the bound address, past loopback. */
export function allowedHosts(tailnet: string | undefined, host: string): string | undefined {
  const hosts = [tailnet, isLoopback(host) ? undefined : host].filter((name): name is string => name !== undefined);
  return hosts.length === 0 ? undefined : hosts.join(',');
}
