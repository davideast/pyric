/**
 * The one warning a Node client gives when the host it attached to runs a
 * different `@pyric/cli` than the one the client loaded (ADR-0011's Node peer
 * boundary). An attach acknowledgment without a version stamp is an older
 * host and stays silent.
 */
import { cliVersion } from '../pkg-version.js';

export function versionSkewGuidance(serveVersion: unknown, remedy: string): string | null {
  const isStamped = typeof serveVersion === 'string';
  if (!isStamped) return null;
  const clientVersion = cliVersion();
  const matches = serveVersion === clientVersion;
  if (matches) return null;
  return `pyric sandbox is running version ${serveVersion}, this client is ${clientVersion}. ${remedy}`;
}
