import { analyzeIndexQuery, readIndexConfig, type IndexQuery, type IndexesConfig, type IndexesConfigEntry } from 'pyric/sandbox/internal';

export interface LocalIndexConfig { path: string; config: IndexesConfig; revision: string }
export interface IndexPreview extends LocalIndexConfig { addition: IndexesConfigEntry | null }
export interface IndexConfigClient {
  read(): Promise<LocalIndexConfig>;
  preview(query: IndexQuery): Promise<IndexPreview>;
  apply(query: IndexQuery, revision: string): Promise<IndexPreview>;
}

/** Same-origin local capability only. Standalone pages do not gain a filesystem writer. */
export function createIndexConfigClient(fetcher: typeof fetch): IndexConfigClient {
  let token: string | undefined;
  async function request(method: string, body?: unknown) {
    if (!token) {
      const response = await fetcher('/__pyric/init.json');
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('No local index configuration is connected.');
      const init = await response.json();
      if (typeof init.sessionToken !== 'string') throw new Error('No local index configuration is connected.');
      token = init.sessionToken;
    }
    const response = await fetcher('/__pyric/indexes', { method, headers: { 'x-pyric-session-token': token!, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('No local index configuration is connected.');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Unable to read the index configuration.');
    readIndexConfig(result.config);
    return result;
  }
  return { read: () => request('GET'), preview: query => request('POST', { query }), apply: (query, revision) => request('PUT', { query, revision }) };
}

export function createIndexInspector(client: IndexConfigClient | undefined, changed: () => void) {
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
    finding: (query: IndexQuery) => analyzeIndexQuery(query, config?.config ?? null),
    refresh: () => run('refresh', async () => { preview = null; config = null; config = client ? await client.read() : null; }),
    prepare: (key: string, query: IndexQuery) => {
      if (preview?.key === key || !config) return;
      const finding = analyzeIndexQuery(query, config.config);
      if (finding.status === 'missing') preview = { key, value: { ...config, addition: finding.index } };
    },
    apply: (key: string, query: IndexQuery) => run('apply', async () => {
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
    copy: (query: IndexQuery, clipboard: Pick<Clipboard, 'writeText'> | undefined) => run('copy', async () => {
      const finding = analyzeIndexQuery(query, config?.config ?? null);
      const definition = finding.status === 'covered' ? preview?.value.addition : finding.index;
      if (!definition) return;
      if (!clipboard) throw new Error('This browser could not copy the index definition.');
      await clipboard.writeText(JSON.stringify(definition, null, 2));
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied = false; if (!disposed) changed(); }, 1800);
    }),
    dispose: () => { disposed = true; clearTimeout(copyTimer); },
  };
}
