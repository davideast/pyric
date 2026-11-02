/**
 * Putting a local port on a private network: WSL's mirrored networking
 * lets the Windows Tailscale reach 127.0.0.1 here, and
 * `tailscale serve --bg --https=<port>` gives `https://<host>:<port>`, where
 * the host is this machine's name on that network (`tailscale status`,
 * or `PYRIC_FACTORY_TAILNET_HOST`). An entry the machine already has is
 * left as it is.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const TAILSCALE = process.env.PYRIC_FACTORY_TAILSCALE ?? '/mnt/c/Program Files/Tailscale/tailscale.exe';

/** The machine's name on the private network, without the trailing dot; undefined when Tailscale can't say. */
export function tailnetHost(): string | undefined {
  const configured = process.env.PYRIC_FACTORY_TAILNET_HOST;
  if (configured !== undefined && configured !== '') return configured;
  if (!existsSync(TAILSCALE)) return undefined;
  const status = tailscale(['status', '--json']);
  if (!status.ok) return undefined;
  const parsed = JSON.parse(status.output) as { Self?: { DNSName?: string } };
  const name = parsed.Self?.DNSName?.replace(/\.$/, '');
  return name === '' ? undefined : name;
}

export function tailnetUrl(port: number, host: string): string {
  return `https://${host}:${port}/`;
}

function tailscale(args: readonly string[]): { ok: boolean; output: string } {
  const result = spawnSync(TAILSCALE, [...args], { encoding: 'utf8', timeout: 30_000 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Whether `tailscale serve status` lists an entry for `port`. */
export function hasServeEntry(status: string, port: number): boolean {
  return new RegExp(`https://\\S+:${port}\\b`).test(status);
}

/** Serves each port on the tailnet unless it already is. Returns one line per port saying what happened. */
export function ensureServed(ports: readonly number[]): string[] {
  if (!existsSync(TAILSCALE)) return [`no tailscale at ${TAILSCALE}; the served copy is on 127.0.0.1 only`];
  const status = tailscale(['serve', 'status']).output;
  return ports.map((port) => {
    if (hasServeEntry(status, port)) return `${port}: already served on the private network`;
    const added = tailscale(['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`]);
    return added.ok ? `${port}: now served on the private network` : `${port}: tailscale serve failed: ${added.output.trim()}`;
  });
}
