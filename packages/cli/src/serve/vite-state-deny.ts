/**
 * Keep the Vite dev server from serving `.pyric/` (#1779).
 *
 * Vite serves every file under its root, including dot directories, so a dev
 * server with the plugin answered `/.pyric/state/hosted/state.sqlite` (users
 * and data) and `/@fs/<project>/.pyric/...`. `server.fs.deny` is the one list
 * Vite checks on both paths. Vite only applies its own defaults when the
 * project sets no `deny`, so the plugin restates them when it adds its entry
 * to an unset list, and otherwise adds only its entry: Vite concatenates the
 * arrays a plugin's `config` hook returns with the project's.
 * https://vite.dev/config/server-options#server-fs-deny
 */

/** Vite's defaults for `server.fs.deny` (Vite 6 and 7). */
const VITE_DEFAULT_FS_DENY = ['.env', '.env.*', '*.{crt,pem}', '**/.git/**'] as const;

/** The directory pyric keeps project state, session files and caches in. */
export const PYRIC_STATE_DENY = '**/.pyric/**';

interface ServerFsConfig {
  server?: { fs?: { deny?: string[] } };
}

/** The `server.fs.deny` entries the plugin's `config` hook returns. */
export function pyricFsDeny(config: ServerFsConfig): string[] {
  const projectDeny = config.server?.fs?.deny;
  const projectSetsDeny = projectDeny !== undefined;
  if (projectSetsDeny) return [PYRIC_STATE_DENY];
  return [...VITE_DEFAULT_FS_DENY, PYRIC_STATE_DENY];
}
