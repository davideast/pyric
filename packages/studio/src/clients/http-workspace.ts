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
  WorkspaceBranch,
  WorkspaceChange,
  WorkspaceEntry,
  WorkspaceStore,
} from '../ports.js';
import { stampedStudioSessionToken } from '../shell/serve-init.js';

export interface HttpWorkspaceOptions {
  token?: string;
  writerId?: string;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

const tokenCache = new Map<string, Promise<string | null>>();
let defaultTabWriterId: string | null = null;
const TOKENS_BY_PORT_KEY = Symbol.for('pyric.localSessionTokensByPort');
const LOOPBACK_IPV4 = /^127(\.\d{1,3}){3}$/;

export function resetSessionTokenCache(): void {
  tokenCache.clear();
}

export function registerStudioSessionToken(baseUrl: string, token: string | undefined): void {
  if (!token) return;
  tokenCache.set(baseUrl.replace(/\/$/, ''), Promise.resolve(token));
}

function inProcessLoopbackTokenForBaseUrl(baseUrl: string): string | undefined {
  if (!baseUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLoopback = host === 'localhost' || host === '::1' || LOOPBACK_IPV4.test(host);
  if (!isLoopback) return undefined;
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) return undefined;
  const holder = globalThis as unknown as Record<symbol, Map<number, string> | undefined>;
  return holder[TOKENS_BY_PORT_KEY]?.get(port);
}

export function getTabWriterId(explicitWriterId?: string): string {
  if (explicitWriterId) return explicitWriterId;
  if (!defaultTabWriterId) {
    defaultTabWriterId = `studio-writer-${Math.random().toString(36).slice(2)}`;
  }
  return defaultTabWriterId;
}

function normalizeWorkspaceOptions(options?: HttpWorkspaceOptions | string): {
  token?: string;
  writerId?: string;
} {
  if (typeof options === 'string') {
    return { token: options };
  }
  return {
    token: options?.token,
    writerId: options?.writerId,
  };
}

export async function resolveSessionToken(baseUrl: string, explicitToken?: string): Promise<string | null> {
  if (explicitToken) return explicitToken;
  const key = baseUrl.replace(/\/$/, '');
  const cached = tokenCache.get(key);
  if (cached) return cached;

  const stamped = stampedStudioSessionToken() ?? inProcessLoopbackTokenForBaseUrl(key);
  const initRequest = stamped
    ? fetch(joinUrl(key, '/__pyric/init.json'), { headers: { 'x-pyric-session-token': stamped } })
    : fetch(joinUrl(key, '/__pyric/init.json'));
  const promise = initRequest
    .then((res) => (res.ok ? res.json() : null))
    .then((data: any) => (typeof data?.sessionToken === 'string' ? data.sessionToken : stamped ?? null))
    .catch(() => stamped ?? null)
    .then((token) => {
      if (!token) {
        tokenCache.delete(key);
      }
      return token;
    });

  tokenCache.set(key, promise);
  return promise;
}

export async function createAuthHeaders(
  baseUrl: string,
  options?: HttpWorkspaceOptions | string,
  includeWriter = false,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const { token: explicitToken, writerId } = normalizeWorkspaceOptions(options);
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
  const { token: explicitToken } = normalizeWorkspaceOptions(options);
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

    async branches() {
      const headers = await getAuthHeaders(false);
      const res = await fetch(joinUrl(base, '/__pyric/workspace/branches'), { headers });
      if (!res.ok) throw new Error(`workspace.branches() → ${res.status}`);
      return (await res.json()) as WorkspaceBranch[];
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

      resolveSessionToken(base, explicitToken)
        .then(async (token) => {
          if (closed) return;
          if (token && explicitToken) {
            await fetch(joinUrl(base, '/__pyric/init.json'), {
              headers: { 'x-pyric-session-token': token },
              credentials: 'same-origin',
            }).catch(() => {});
          }
          if (closed) return;
          source = new EventSource(joinUrl(base, '/__pyric/workspace/watch'));
          source.addEventListener('change', onChange);
        })
        .catch(() => {});

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
