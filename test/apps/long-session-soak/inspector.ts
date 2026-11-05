// A small client for the dev server's Node inspector, which the soak opens
// with NODE_OPTIONS=--inspect on a port of its own. It collects garbage before
// a memory sample, so a heap the process has not collected yet does not read
// as growth, and takes heap snapshots for the growth summary in soak.ts.

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

/** One inspector session on a Node process. */
export class NodeInspector {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, (params: unknown) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
      if (message.method) this.listeners.get(message.method)?.(message.params);
      if (message.id === undefined) return;
      const waiting = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const waiting of this.pending.values()) waiting.reject(new Error('the inspector socket closed'));
      this.pending.clear();
    });
  }

  /** Connects to the process listening for an inspector on `port`. */
  static async connect(port: number): Promise<NodeInspector> {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ webSocketDebuggerUrl: string }>;
    const url = targets[0]?.webSocketDebuggerUrl;
    if (!url) throw new Error(`the inspector on port ${port} lists no target`);
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`could not open ${url}`)), { once: true });
    });
    return new NodeInspector(socket);
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const answer = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return answer;
  }

  /** Collects garbage, then reads `process.memoryUsage()` in the process. */
  async memoryAfterCollection(): Promise<{ heapUsed: number; rss: number }> {
    await this.send('HeapProfiler.collectGarbage');
    const { result } = await this.send<{ result: { value: string } }>('Runtime.evaluate', {
      expression: 'JSON.stringify(process.memoryUsage())',
      returnByValue: true,
    });
    return JSON.parse(result.value) as { heapUsed: number; rss: number };
  }

  /** A heap snapshot, as the JSON text the inspector streams. */
  async heapSnapshot(): Promise<string> {
    const chunks: string[] = [];
    this.listeners.set('HeapProfiler.addHeapSnapshotChunk', (params) => chunks.push((params as { chunk: string }).chunk));
    try {
      await this.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    } finally {
      this.listeners.delete('HeapProfiler.addHeapSnapshotChunk');
    }
    return chunks.join('');
  }

  close(): void {
    this.socket.close();
  }
}

/** The dev server's environment: an inspector on a port of the soak's own, for collections and heap snapshots. */
export function inspectedEnv(inspectorPort: number): Record<string, string> {
  return { NODE_OPTIONS: `--inspect=127.0.0.1:${inspectorPort}` };
}
