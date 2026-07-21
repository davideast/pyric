import {
  createIdbJobStore,
  createJobEngine,
  type IdbJobStore,
  type JobEvent,
  type JobStatus,
  type ProducerCtx,
} from '@inbrowser/resumable';

export type AgentRunEvent =
  | { kind: 'text'; chunk: string }
  | { kind: 'thinking'; chunk: string }
  | { kind: 'tool'; tool: unknown }
  | { kind: 'usage'; usage: unknown };

type QueueItem = AgentRunEvent | { kind: '__done'; status: JobStatus; reason?: string };

/** Durable append-only event log for a browser agent run. */
export class AgentRunRecorder {
  private readonly store = createIdbJobStore({ dbName: 'PyChat-agent-runs' }) as IdbJobStore<AgentRunEvent>;
  private readonly engine = createJobEngine({ store: this.store });
  private readonly queue: QueueItem[] = [];
  private readonly waiters: Array<(item: QueueItem) => void> = [];
  private closed = false;
  private readonly ready: Promise<{ jobId: string }>;

  constructor(meta: Record<string, unknown>) {
    this.ready = this.engine.start(this.producer.bind(this), { data: meta, ttlMs: 1000 * 60 * 60 * 24 * 14 });
  }

  async jobId(): Promise<string> {
    return (await this.ready).jobId;
  }

  push(event: AgentRunEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.queue.push(event);
  }

  finish(): void {
    this.close({ kind: '__done', status: 'done' });
  }

  fail(reason: string): void {
    this.close({ kind: '__done', status: 'error', reason });
  }

  async replay(from = 0, signal?: AbortSignal): Promise<AsyncIterable<JobEvent<AgentRunEvent>>> {
    const { jobId } = await this.ready;
    return this.engine.subscribe(jobId, { from, signal });
  }

  async dispose(): Promise<void> {
    await this.engine.stop();
    this.store.close();
  }

  private close(item: QueueItem): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.queue.push(item);
  }

  private async *producer(_ctx: ProducerCtx): AsyncIterable<AgentRunEvent> {
    while (true) {
      const item = this.queue.shift() ?? await new Promise<QueueItem>((resolve) => this.waiters.push(resolve));
      if (item.kind === '__done') {
        if (item.status === 'error') throw new Error(item.reason ?? 'Agent run failed');
        return;
      }
      yield item;
    }
  }
}
