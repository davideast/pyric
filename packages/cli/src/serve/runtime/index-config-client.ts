import { indexPresentation } from './service-presentation.js';
import { analyzeServiceIndex, indexService, readIndexConfig, type ServiceIndexQuery, type ServiceIndexConfig, type ServiceIndexDefinition } from 'pyric/sandbox/internal';

export interface LocalIndexConfig { path: string; config: ServiceIndexConfig; revision: string }
export interface IndexPreview extends LocalIndexConfig { addition: ServiceIndexDefinition | null }
export interface IndexConfigClient {
  read(service?: 'firestore' | 'rtdb'): Promise<LocalIndexConfig>;
  preview(query: ServiceIndexQuery): Promise<IndexPreview>;
  apply(query: ServiceIndexQuery, revision: string): Promise<IndexPreview>;
}

/** Same-origin local capability only. Standalone pages do not gain a filesystem writer. */
export function createIndexConfigClient(fetcher: typeof fetch): IndexConfigClient {
  let token: string | undefined;
  async function request(method: string, body?: unknown, service: 'firestore' | 'rtdb' = 'firestore') {
    if (!token) {
      const response = await fetcher('/__pyric/init.json');
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('No local index configuration is connected.');
      const init = await response.json();
      if (typeof init.sessionToken !== 'string') throw new Error('No local index configuration is connected.');
      token = init.sessionToken;
    }
    const response = await fetcher(service === 'firestore' ? '/__pyric/indexes' : '/__pyric/indexes?service=rtdb', { method, headers: { 'x-pyric-session-token': token!, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('No local index configuration is connected.');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Unable to read the index configuration.');
    if (service === 'firestore') readIndexConfig(result.config);
    else if (!result.config?.rules || typeof result.config.rules !== 'object') throw new Error('No local database rules are connected.');
    return result;
  }
  return { read: service => request('GET', undefined, service), preview: query => request('POST', { query }, indexService(query)), apply: (query, revision) => request('PUT', { query, revision }, indexService(query)) };
}

function createServiceInspector(client: IndexConfigClient | undefined, changed: () => void, service: 'firestore' | 'rtdb') {
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
    busy = true; pending = kind;
    if (kind === 'apply') saveFailed = false;
    error = null; message = null; changed();
    try { await action(); } catch (cause) { if (kind === 'apply') saveFailed = true; error = cause instanceof Error ? cause.message : 'Unable to check index configuration.'; }
    finally { busy = false; pending = null; if (!disposed) changed(); }
  }
  return {
    state: () => ({ config, error, busy, pending, saveFailed, copied, preview, message }),
    finding: (query: ServiceIndexQuery) => analyzeServiceIndex(query, config?.config ?? null),
    refresh: () => run('refresh', async () => { preview = null; config = null; config = client ? await client.read(service) : null; }),
    prepare: (key: string, query: ServiceIndexQuery) => {
      if (preview?.key === key || !config) return;
      const finding = analyzeServiceIndex(query, config.config);
      if (finding.status === 'missing' && !finding.editBlocked) preview = { key, value: { ...config, addition: finding.index } };
    },
    apply: (key: string, query: ServiceIndexQuery) => run('apply', async () => {
      if (!client || preview?.key !== key) return;
      const current = await client.preview(query);
      if (current.revision !== preview.value.revision) {
        config = current; preview = { key, value: current };
        message = 'Configuration changed. Review the index before adding it.';
        return;
      }
      const addition = preview.value.addition;
      const value = await client.apply(query, preview.value.revision);
      config = value; preview = { key, value: { ...value, addition } };
    }),
    copy: (query: ServiceIndexQuery, clipboard: Pick<Clipboard, 'writeText'> | undefined) => run('copy', async () => {
      const finding = analyzeServiceIndex(query, config?.config ?? null);
      const definition = finding.status === 'covered' ? preview?.value.addition : finding.index;
      if (!definition) return;
      if (!clipboard) throw new Error('This browser could not copy the index definition.');
      await clipboard.writeText(JSON.stringify(indexPresentation(query, definition).definition, null, 2));
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied = false; if (!disposed) changed(); }, 1800);
    }),
    dispose: () => { disposed = true; clearTimeout(copyTimer); },
  };
}

/** Each service owns its config revision and pending action; the UI consumes one interface. */
export function createIndexInspector(client: IndexConfigClient | undefined, changed: () => void) {
  const inspectors = { firestore: createServiceInspector(client, changed, 'firestore'), rtdb: createServiceInspector(client, changed, 'rtdb') };
  const inspector = (query?: ServiceIndexQuery) => inspectors[query ? indexService(query) : 'firestore'];
  return {
    state: (query?: ServiceIndexQuery) => inspector(query).state(),
    finding: (query: ServiceIndexQuery) => inspector(query).finding(query),
    prepare: (key: string, query: ServiceIndexQuery) => inspector(query).prepare(key, query),
    apply: (key: string, query: ServiceIndexQuery) => inspector(query).apply(key, query),
    copy: (query: ServiceIndexQuery, clipboard: Pick<Clipboard, 'writeText'> | undefined) => inspector(query).copy(query, clipboard),
    refresh: async () => { await Promise.all(Object.values(inspectors).map(value => value.refresh())); },
    dispose: () => { Object.values(inspectors).forEach(value => value.dispose()); },
  };
}
