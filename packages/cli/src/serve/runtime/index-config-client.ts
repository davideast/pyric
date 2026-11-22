import {
  analyzeServiceIndex,
  indexService,
  readIndexConfig,
  type ServiceIndexConfig,
  type ServiceIndexDefinition,
  type ServiceIndexQuery,
} from 'pyric/sandbox/internal';
import { stampedSessionToken } from './hosted-target.js';
import { indexPresentation } from './service-presentation.js';

interface LocalIndexConfig {
  service?: 'firestore' | 'rtdb';
  status?: 'configured' | 'unconfigured';
  path: string;
  config: ServiceIndexConfig;
  revision: string;
}
interface IndexPreview extends LocalIndexConfig {
  addition: ServiceIndexDefinition | null;
}
export interface IndexConfigClient {
  read(service?: 'firestore' | 'rtdb'): Promise<LocalIndexConfig | null>;
  preview(query: ServiceIndexQuery): Promise<IndexPreview>;
  apply(query: ServiceIndexQuery, revision: string): Promise<IndexPreview>;
}

interface IndexInitSummary {
  sessionToken?: unknown;
  remotePeer?: unknown;
}

function indexesPathForService(service: 'firestore' | 'rtdb' | undefined): string {
  if (service === 'rtdb') return '/__pyric/indexes?service=rtdb';
  if (service === 'firestore') return '/__pyric/indexes?service=firestore';
  return '/__pyric/indexes';
}

/** Same-origin local capability only. Standalone and remote pages do not gain a filesystem writer. */
export function createIndexConfigClient(
  fetcher: typeof fetch,
  options: { init?: Promise<IndexInitSummary | null> } = {},
): IndexConfigClient {
  let token: string | undefined;
  let initPromise: Promise<void> | undefined;

  function ensureInit(): Promise<void> {
    if (initPromise !== undefined) return initPromise;
    let isTerminal = false;
    const attempt = (async () => {
      const stamped = stampedSessionToken();
      if (options.init !== undefined) {
        let provided: IndexInitSummary | null;
        try {
          provided = await options.init;
        } catch {
          isTerminal = true;
          throw new Error('No local index configuration is connected.');
        }
        if (provided === null || provided.remotePeer === true) {
          isTerminal = true;
          throw new Error('No local index configuration is connected.');
        }
        token = typeof provided.sessionToken === 'string' ? provided.sessionToken : stamped;
        return;
      }
      const initRequest: RequestInit = {};
      if (stamped !== undefined) {
        initRequest.headers = { 'x-pyric-session-token': stamped };
      }
      const response = await fetcher('/__pyric/init.json', initRequest);
      if (response.status === 401 || response.status === 403) {
        isTerminal = true;
        throw new Error('No local index configuration is connected.');
      }
      const isJson = response.headers.get('content-type')?.includes('application/json') === true;
      if (!response.ok || !isJson) {
        throw new Error('No local index configuration is connected.');
      }
      const init = (await response.json()) as IndexInitSummary;
      if (init.remotePeer === true) {
        isTerminal = true;
        throw new Error('No local index configuration is connected.');
      }
      token = typeof init.sessionToken === 'string' ? init.sessionToken : stamped;
    })();
    initPromise = attempt;
    void attempt.catch(() => {
      // Allow manual retry after transient network/5xx errors; cache terminal refusals.
      if (!isTerminal && initPromise === attempt) {
        initPromise = undefined;
      }
    });
    return attempt;
  }

  async function request(method: string, body?: unknown, service?: 'firestore' | 'rtdb') {
    await ensureInit();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== undefined) headers['x-pyric-session-token'] = token;
    const requestInit: RequestInit = { method, headers };
    if (body !== undefined) {
      requestInit.body = JSON.stringify(body);
    }
    const response = await fetcher(indexesPathForService(service), requestInit);
    const isJson = response.headers.get('content-type')?.includes('application/json') === true;
    if (!isJson) {
      throw new Error('No local index configuration is connected.');
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Unable to read the index configuration.');
    if (result.status === 'unavailable') {
      throw new Error(result.reason ?? 'Unable to read the index configuration.');
    }
    if (result.status === 'unconfigured' || result.unconfigured || !result.config) return null;
    const targetService = service ?? result.service;
    if (targetService === 'firestore') {
      readIndexConfig(result.config);
    } else if (!result.config?.rules || typeof result.config.rules !== 'object') {
      throw new Error('No local database rules are connected.');
    }
    return result;
  }

  return {
    read: service => request('GET', undefined, service) as Promise<LocalIndexConfig | null>,
    preview: query => request('POST', { query }, indexService(query)) as Promise<IndexPreview>,
    apply: (query, revision) =>
      request('PUT', { query, revision }, indexService(query)) as Promise<IndexPreview>,
  };
}

function createServiceInspector(
  client: IndexConfigClient | undefined,
  changed: () => void,
  service: 'firestore' | 'rtdb',
) {
  let config: LocalIndexConfig | null = null;
  let error: string | null = null;
  let busy = false;
  let pending: 'apply' | 'copy' | 'refresh' | null = null;
  let saveFailed = false;
  let copied = false;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let preview: { key: string; value: IndexPreview } | null = null;
  let disposed = false;
  let message: string | null = null;

  async function run(kind: 'apply' | 'copy' | 'refresh', action: () => Promise<void>) {
    if (busy || disposed) return;
    busy = true;
    pending = kind;
    if (kind === 'apply') saveFailed = false;
    error = null;
    message = null;
    changed();
    try {
      await action();
    } catch (cause) {
      if (kind === 'apply') saveFailed = true;
      error = cause instanceof Error ? cause.message : 'Unable to check index configuration.';
    } finally {
      busy = false;
      pending = null;
      if (!disposed) changed();
    }
  }

  return {
    state: () => ({ config, error, busy, pending, saveFailed, copied, preview, message }),
    finding: (query: ServiceIndexQuery) => analyzeServiceIndex(query, config?.config ?? null),
    refresh: () =>
      run('refresh', async () => {
        preview = null;
        config = null;
        config = client ? await client.read(service) : null;
      }),
    prepare: (key: string, query: ServiceIndexQuery) => {
      if (preview?.key === key || !config) return;
      const finding = analyzeServiceIndex(query, config.config);
      if (finding.status === 'missing' && !finding.editBlocked) {
        preview = { key, value: { ...config, addition: finding.index } };
      }
    },
    apply: (key: string, query: ServiceIndexQuery) =>
      run('apply', async () => {
        if (!client || preview?.key !== key) return;
        const current = await client.preview(query);
        if (current.revision !== preview.value.revision) {
          config = current;
          preview = { key, value: current };
          message = 'Configuration changed. Review the index before adding it.';
          return;
        }
        const addition = preview.value.addition;
        const value = await client.apply(query, preview.value.revision);
        config = value;
        preview = { key, value: { ...value, addition } };
      }),
    copy: (query: ServiceIndexQuery, clipboard: Pick<Clipboard, 'writeText'> | undefined) =>
      run('copy', async () => {
        const finding = analyzeServiceIndex(query, config?.config ?? null);
        const definition =
          finding.status === 'covered' ? preview?.value.addition : finding.index;
        if (!definition) return;
        if (!clipboard) throw new Error('This browser could not copy the index definition.');
        await clipboard.writeText(
          JSON.stringify(indexPresentation(query, definition).definition, null, 2),
        );
        copied = true;
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => {
          copied = false;
          if (!disposed) changed();
        }, 1800);
      }),
    dispose: () => {
      disposed = true;
      clearTimeout(copyTimer);
    },
  };
}

/** Each service owns its config revision and pending action; the UI consumes one interface. */
export function createIndexInspector(client: IndexConfigClient | undefined, changed: () => void) {
  const inspectors = {
    firestore: createServiceInspector(client, changed, 'firestore'),
    rtdb: createServiceInspector(client, changed, 'rtdb'),
  };
  const inspector = (query?: ServiceIndexQuery) => {
    const key = query ? indexService(query) : 'firestore';
    return inspectors[key];
  };
  return {
    state: (query?: ServiceIndexQuery) => inspector(query).state(),
    finding: (query: ServiceIndexQuery) => inspector(query).finding(query),
    prepare: (key: string, query: ServiceIndexQuery) => inspector(query).prepare(key, query),
    apply: (key: string, query: ServiceIndexQuery) => inspector(query).apply(key, query),
    copy: (query: ServiceIndexQuery, clipboard: Pick<Clipboard, 'writeText'> | undefined) =>
      inspector(query).copy(query, clipboard),
    refresh: async () => {
      await Promise.all(Object.values(inspectors).map(value => value.refresh()));
    },
    dispose: () => {
      Object.values(inspectors).forEach(value => value.dispose());
    },
  };
}
