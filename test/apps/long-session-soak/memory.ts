// The soak's memory readings: the page's JS heap through CDP, and the dev
// server's heap and RSS through its inspector, each after a full collection.
// It judges them for steady growth, and for a long process that never levels
// off, and with SOAK_HEAP_SNAPSHOTS=1 names what grew between two snapshots.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  growingHeapTypes,
  growingRetainers,
  judgeGrowth,
  judgeLevelOff,
  summarizeHeap,
  type GrowthLimit,
  type HeapSummary,
  type LevelOffLimit,
  type MemorySample,
} from '../soak.ts';
import { NodeInspector } from './inspector.ts';
import { within } from './model.ts';
import { ACTION_LIMIT_MS } from './page-api.ts';
import type { Session } from './session.ts';

const MB = 1024 * 1024;
const PAGE_HEAP_LIMIT: GrowthLimit = { floorBytes: 48 * MB, ratio: 1, minSamples: 5 };
const SERVER_HEAP_LIMIT: GrowthLimit = { floorBytes: 64 * MB, ratio: 0.5, minSamples: 5 };
const SERVER_RSS_LIMIT: GrowthLimit = { floorBytes: 192 * MB, ratio: 0.75, minSamples: 5 };
/** A process of 10 minutes or more must be flat in its second half: the observation history's caps are reached by then. */
export const SERVER_HEAP_LEVEL: LevelOffLimit = { minMinutes: 10, maxBytesPerMinute: 1 * MB };
/** RSS moves in allocator steps, so it gets more room. */
export const SERVER_RSS_LEVEL: LevelOffLimit = { minMinutes: 10, maxBytesPerMinute: 4 * MB };
const SNAPSHOT_LIMIT_MS = 120_000;

export class SoakMemory {
  readonly pageHeap: MemorySample[] = [];
  /** The dev server's V8 heap and its RSS, each read after a full collection. */
  readonly serverHeap: MemorySample[] = [];
  readonly serverRss: MemorySample[] = [];
  /** Server epochs a heap snapshot was taken in. Taking one raises RSS for good, so their RSS is not judged. */
  readonly snapshotEpochs = new Set<number>();
  private inspector: NodeInspector | undefined;
  /** The first heap snapshot's summary, with SOAK_HEAP_SNAPSHOTS=1, until the second is taken. */
  private firstSnapshot: { at: number; summary: HeapSummary } | undefined;
  private snapshotsDone = false;

  constructor(
    private readonly session: Session,
    private readonly inspectorPort: number,
    private readonly takeSnapshots: boolean,
    private readonly results: string,
  ) {}

  /** One reading of the page's JS heap, after a collection. */
  async samplePage(): Promise<void> {
    const { session } = this;
    const at = session.seconds;
    const cdp = await session.context.newCDPSession(session.page);
    try {
      await within('the page heap collection', ACTION_LIMIT_MS, cdp.send('HeapProfiler.collectGarbage'));
      const { usedSize } = await within('the page heap reading', ACTION_LIMIT_MS, cdp.send('Runtime.getHeapUsage'));
      this.pageHeap.push({ at, epoch: session.pageEpoch, bytes: usedSize });
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  /** One reading of the dev server's heap and RSS, after a collection. */
  async sampleServer(): Promise<void> {
    const at = this.session.seconds;
    const inspector = await this.serverInspector();
    const server = await within('the dev server memory reading', ACTION_LIMIT_MS, inspector.memoryAfterCollection());
    this.serverHeap.push({ at, epoch: this.session.serverEpoch, bytes: server.heapUsed });
    this.serverRss.push({ at, epoch: this.session.serverEpoch, bytes: server.rss });
  }

  closeInspector(): void {
    this.inspector?.close();
    this.inspector = undefined;
  }

  private async serverInspector(): Promise<NodeInspector> {
    this.inspector ??= await within('connecting to the dev server inspector', ACTION_LIMIT_MS, NodeInspector.connect(this.inspectorPort));
    return this.inspector;
  }

  /** Whether the first heap snapshot is still to be taken. */
  get wantsFirstSnapshot(): boolean {
    return this.takeSnapshots && !this.firstSnapshot;
  }

  /**
   * With SOAK_HEAP_SNAPSHOTS=1: a heap snapshot of the dev server at the first
   * checkpoint, and another just before the first restart, so both come from
   * one process. The kinds of object that grew between them are saved.
   */
  async heapSnapshot(): Promise<void> {
    const { session } = this;
    if (!this.takeSnapshots || this.snapshotsDone || session.serverEpoch > 0) return;
    const inspector = await this.serverInspector();
    this.snapshotEpochs.add(session.serverEpoch);
    const summary = summarizeHeap(await within('a dev server heap snapshot', SNAPSHOT_LIMIT_MS, inspector.heapSnapshot()));
    if (!this.firstSnapshot) {
      this.firstSnapshot = { at: session.seconds, summary };
      return;
    }
    this.snapshotsDone = true;
    const types = growingHeapTypes(this.firstSnapshot.summary.types, summary.types, 30).map((row) =>
      `${(row.bytesGrowth / MB).toFixed(2).padStart(8)} MB  ${String(row.countGrowth).padStart(8)} objects  ${row.name}  (now ${(row.bytes / MB).toFixed(2)} MB in ${row.count})`);
    const retainers = growingRetainers(this.firstSnapshot.summary.retainers, summary.retainers, 40).map((row) =>
      `${String(row.growth).padStart(8)} more  ${row.path}  (now ${row.count})`);
    const span = `from +${this.firstSnapshot.at.toFixed(0)}s to +${session.seconds.toFixed(0)}s, after a collection`;
    const text = [
      `dev server heap growth ${span}, by kind (self sizes):`, ...types, '',
      `references that grew ${span}, as <kind> <- <holder>.<property>:`, ...retainers,
    ];
    writeFileSync(join(this.results, 'soak-heap-growth.txt'), `${text.join('\n')}\n`);
  }

  /** Every epoch of every reading, judged or listed as not judged. */
  verdict(): { growing: boolean; report: string } {
    const unsnapshotted = this.serverRss.filter((sample) => !this.snapshotEpochs.has(sample.epoch));
    const skipped = [...this.snapshotEpochs].map((epoch) => `epoch ${epoch}: not judged, a heap snapshot was taken in it`);
    const verdicts = [
      { title: 'page JS heap, steady growth per page load:', verdict: judgeGrowth(this.pageHeap, PAGE_HEAP_LIMIT), extra: [] },
      { title: 'dev server heap used, steady growth per process:', verdict: judgeGrowth(this.serverHeap, SERVER_HEAP_LIMIT), extra: [] },
      { title: 'dev server heap used, levelling off in a long process:', verdict: judgeLevelOff(this.serverHeap, SERVER_HEAP_LEVEL), extra: [] },
      { title: 'dev server RSS, steady growth per process:', verdict: judgeGrowth(unsnapshotted, SERVER_RSS_LIMIT), extra: skipped },
      { title: 'dev server RSS, levelling off in a long process:', verdict: judgeLevelOff(unsnapshotted, SERVER_RSS_LEVEL), extra: skipped },
    ];
    const report = verdicts.flatMap(({ title, verdict, extra }) => [title, ...verdict.lines, ...extra]).join('\n');
    return { growing: verdicts.some(({ verdict }) => verdict.growing), report };
  }
}
