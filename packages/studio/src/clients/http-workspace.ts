/**
 * `httpWorkspace(baseUrl)`: a {@link WorkspaceStore} that satisfies the port
 * browser-side by talking to the pyric server's `/__pyric/workspace` routes
 * (the disk-backed store in pyric-tools). `watch` consumes the SSE stream at
 * `/__pyric/workspace/watch`.
 *
 * `baseUrl` is the server origin (e.g. `''` for same-origin, or
 * `http://localhost:5000`). Paths are project-relative POSIX strings, passed as
 * the `?path=` query.
 */
import type {
  WorkspaceChange,
  WorkspaceEntry,
  WorkspaceStore,
} from '../ports.js';

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

export function httpWorkspace(baseUrl: string): WorkspaceStore {
  const base = baseUrl;

  return {
    async read(path) {
      const res = await fetch(
        joinUrl(base, `/__pyric/workspace?path=${encodeURIComponent(path)}`),
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`workspace.read(${path}) → ${res.status}`);
      return res.text();
    },

    async write(path, content) {
      const res = await fetch(
        joinUrl(base, `/__pyric/workspace?path=${encodeURIComponent(path)}`),
        { method: 'PUT', body: content },
      );
      if (!res.ok) throw new Error(`workspace.write(${path}) → ${res.status}`);
    },

    async list(dir) {
      const q = dir ? `?dir=${encodeURIComponent(dir)}` : '';
      const res = await fetch(joinUrl(base, `/__pyric/workspace/list${q}`));
      if (!res.ok) throw new Error(`workspace.list(${dir ?? ''}) → ${res.status}`);
      return (await res.json()) as WorkspaceEntry[];
    },

    async remove(path) {
      const res = await fetch(
        joinUrl(base, `/__pyric/workspace?path=${encodeURIComponent(path)}`),
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(`workspace.remove(${path}) → ${res.status}`);
    },

    watch(cb) {
      const source = new EventSource(joinUrl(base, '/__pyric/workspace/watch'));
      const onChange = (e: MessageEvent): void => {
        try {
          cb(JSON.parse(e.data) as WorkspaceChange);
        } catch {
          /* ignore malformed frame */
        }
      };
      source.addEventListener('change', onChange);
      return () => {
        source.removeEventListener('change', onChange);
        source.close();
      };
    },
  };
}
