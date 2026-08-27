/**
 * `httpWorkspace(baseUrl)`: a {@link WorkspaceStore} that satisfies the port
 * browser-side by talking to the pyric devr's `/__pyric/workspace` routes
 * (the disk-backed store in @pyric/cli). `watch` consumes the SSE stream at
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

export interface HttpWorkspaceOptions {
  token?: string;
  writerId?: string;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

const tokenCache = new Map<string, Promise<string | null>>();
let defaultTabWriterId: string | null = null;

export function resetSessionTokenCache(): void {
  tokenCache.clear();
}

export function getTabWriterId(explicitWriterId?: string): string {
  if (explicitWriterId) return explicitWriterId;
  if (!defaultTabWriterId) {
    defaultTabWriterId = `studio-writer-${Math.random().toString(36).slice(2)}`;
  }
  return defaultTabWriterId;
}

export async function resolveSessionToken(baseUrl: string, explicitToken?: string): Promise<string | null> {
  if (explicitToken) return explicitToken;
  const key = baseUrl.replace(/\/$/, '');
  let promise = tokenCache.get(key);
  if (!promise) {
    promise = fetch(joinUrl(key, '/__pyric/init.json'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data: any) => (data?.sessionToken ?? null) as string | null)
      .catch(() => null);
    tokenCache.set(key, promise);
  }
  return promise;
}

export async function createAuthHeaders(
  baseUrl: string,
  options?: HttpWorkspaceOptions | string,
  includeWriter = false,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const explicitToken = typeof options === 'string' ? options : options?.token;
  const writerId = typeof options === 'object' ? options?.writerId : undefined;
  if (includeWriter) {
    headers['x-pyric-writer'] = getTabWriterId(writerId);
  }
  const token = await resolveSessionToken(baseUrl, explicitToken);
  if (token) {
    headers['x-pyric-session-token'] = token;
  }
  return headers;
}

export function httpWorkspace(
  baseUrl: string,
  options?: HttpWorkspaceOptions | string,
): WorkspaceStore {
  const base = baseUrl;
  const explicitToken = typeof options === 'string' ? options : options?.token;
  const getAuthHeaders = (includeWriter = false) => createAuthHeaders(base, options, includeWriter);

  return {
    async read(path) {
      const headers = await getAuthHeaders(false);
      const res = await fetch(
        joinUrl(base, `/__pyric/workspace?path=${encodeURIComponent(path)}`),
        { headers },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`workspace.read(${path}) → ${res.status}`);
      return res.text();
    },

    async write(path, content) {
      const headers = await getAuthHeaders(true);
      const res = await fetch(
        joinUrl(base, `/__pyric/workspace?path=${encodeURIComponent(path)}`),
        { method: 'PUT', headers, body: content },
      );
      if (!res.ok) throw new Error(`workspace.write(${path}) → ${res.status}`);
    },

    async list(dir) {
      const headers = await getAuthHeaders(false);
      const q = dir ? `?dir=${encodeURIComponent(dir)}` : '';
      const res = await fetch(joinUrl(base, `/__pyric/workspace/list${q}`), { headers });
      if (!res.ok) throw new Error(`workspace.list(${dir ?? ''}) → ${res.status}`);
      return (await res.json()) as WorkspaceEntry[];
    },

    async remove(path) {
      const headers = await getAuthHeaders(true);
      const res = await fetch(
        joinUrl(base, `/__pyric/workspace?path=${encodeURIComponent(path)}`),
        { method: 'DELETE', headers },
      );
      if (!res.ok) throw new Error(`workspace.remove(${path}) → ${res.status}`);
    },

    watch(cb) {
      let source: EventSource | null = null;
      let closed = false;

      const onChange = (e: MessageEvent): void => {
        try {
          cb(JSON.parse(e.data) as WorkspaceChange);
        } catch {
          /* ignore malformed frame */
        }
      };

      resolveSessionToken(base, explicitToken).then((token) => {
        if (closed) return;
        const watchUrl = token
          ? joinUrl(base, `/__pyric/workspace/watch?token=${encodeURIComponent(token)}`)
          : joinUrl(base, '/__pyric/workspace/watch');
        source = new EventSource(watchUrl);
        source.addEventListener('change', onChange);
      });

      return () => {
        closed = true;
        if (source) {
          source.removeEventListener('change', onChange);
          source.close();
        }
      };
    },
  };
}
