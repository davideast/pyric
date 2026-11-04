// Firestore's Listen and Write streams, answered from recorded exchanges.
//
// Listen: each `addTarget` is matched to a recorded target. Its first batch is
// sent at once, each later batch when the write exchange it names is answered,
// and after every batch a global target change with a read time marks the
// snapshot consistent, as production does. A target no recording holds is
// removed with a FAILED_PRECONDITION cause that names it, so the SDK's
// listener fails with that message.
//
// Write: the handshake (a message with no writes) gets a stream token. Each
// later message is matched to a recorded write by its writes and answered with
// the recorded response, or the recorded stream error. A write no recording
// holds fails the stream with FAILED_PRECONDITION.
import { EventEmitter } from 'node:events';
import type { Json, JsonObject, ListenExchange, Recording, WriteExchange } from './format.ts';
import { fill, matches, ReplayClock, ReplayTokens, type FillContext } from './values.ts';
import type { StreamHandler, WebChannelSession } from './webchannel.ts';

/** Where a stream's answers go: a WebChannel session or a gRPC call. */
export type StreamSession = Pick<WebChannelSession, 'send' | 'fail'>;

/** One request a client sent: a stream message or an Auth REST call, matched or not. */
export interface Received {
  rpc: 'Listen' | 'Write' | 'auth';
  as: string | null;
  message: Json;
}

/** A request the recordings do not answer. The replay server lists each one. */
export interface Unmatched {
  /**
   * The stream or REST surface, `http` for a host or path this harness does
   * not replay, or `grpc` for a Firestore RPC other than Listen and Write.
   */
  rpc: 'Listen' | 'Write' | 'auth' | 'http' | 'grpc';
  as: string | null;
  request: Json;
}

const TARGET_ONLY_KEYS = ['targetId', 'resumeToken', 'readTime', 'expectedCount', 'once'];

/** The parts of an `addTarget` that name what it reads. */
export function targetShape(addTarget: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(addTarget).filter(([key]) => !TARGET_ONLY_KEYS.includes(key)));
}

/** State every stream on one replay server shares. */
export class ReplayState {
  readonly clock = new ReplayClock();
  readonly tokens = new ReplayTokens();
  readonly unmatched: Unmatched[] = [];
  /** Every request any client sent, in arrival order, so a caller can show that a call sent none. */
  readonly received: Received[] = [];
  /** Emits `answered` with a write exchange id and its commit time. */
  readonly writes = new EventEmitter();
  private readonly used = new Set<string>();

  constructor(readonly recordings: Recording[]) {
    this.writes.setMaxListeners(0);
  }

  get project(): string {
    return this.recordings[0]?.project ?? 'unknown';
  }

  context(extra: Partial<FillContext> = {}): FillContext {
    return { clock: this.clock, tokens: this.tokens, project: this.project, ...extra };
  }

  /** The first matching exchange not yet used, or the last matching one when all are used. */
  take<T extends ListenExchange | WriteExchange>(kind: T['kind'], as: string | null, fits: (exchange: T) => boolean): T | null {
    const candidates = this.recordings
      .flatMap((recording) => recording.exchanges)
      .filter((exchange): exchange is T => exchange.kind === kind)
      .filter((exchange) => (exchange.as === undefined || exchange.as === as) && fits(exchange));
    const chosen = candidates.find((exchange) => !this.used.has(exchange.id)) ?? candidates.at(-1) ?? null;
    if (chosen) this.used.add(chosen.id);
    return chosen;
  }
}

const NO_RECORDING = (what: string) => ({
  code: 9,
  status: 'FAILED_PRECONDITION',
  message: `pyric replay has no recorded exchange for this ${what}`,
});

export class ListenStream implements StreamHandler {
  private readonly active = new Map<number, () => void>();

  constructor(private readonly session: StreamSession, private readonly state: ReplayState, private readonly as: string | null) {}

  onMessage(message: JsonObject): void {
    this.state.received.push({ rpc: 'Listen', as: this.as, message });
    const addTarget = message.addTarget as JsonObject | undefined;
    if (addTarget) this.add(addTarget);
    if (typeof message.removeTarget === 'number') this.remove(message.removeTarget);
  }

  onClose(): void {
    for (const stop of this.active.values()) stop();
    this.active.clear();
  }

  private add(addTarget: JsonObject): void {
    const targetId = addTarget.targetId as number;
    const shape = targetShape(addTarget);
    const exchange = this.state.take<ListenExchange>('listen', this.as, (candidate) => matches(candidate.target, shape));
    if (!exchange) {
      this.state.unmatched.push({ rpc: 'Listen', as: this.as, request: shape });
      const cause = NO_RECORDING(`target: ${JSON.stringify(shape)}`);
      this.session.send({ targetChange: { targetChangeType: 'REMOVE', targetIds: [targetId], cause: { code: cause.code, message: cause.message } } });
      return;
    }
    const [first, ...later] = exchange.batches;
    if (first) this.sendBatch(first.messages, targetId);
    const onAnswered = (writeId: string, commitTime: string | undefined) => {
      for (const batch of later.filter((candidate) => candidate.after === writeId)) this.sendBatch(batch.messages, targetId, commitTime);
    };
    this.state.writes.on('answered', onAnswered);
    this.active.set(targetId, () => this.state.writes.off('answered', onAnswered));
  }

  private remove(targetId: number): void {
    this.active.get(targetId)?.();
    this.active.delete(targetId);
    this.session.send({ targetChange: { targetChangeType: 'REMOVE', targetIds: [targetId] } });
  }

  /** Sends one batch. A batch a write released fills `commitTime` with that write's commit time. */
  private sendBatch(messages: JsonObject[], targetId: number, commitTime?: string): void {
    const context = this.state.context({ targetId, commitTime });
    for (const message of messages) this.session.send(fill(message, context) as JsonObject);
    this.session.send({ targetChange: { readTime: this.state.clock.next() } });
  }
}

export class WriteStream implements StreamHandler {
  private handshaken = false;

  constructor(private readonly session: StreamSession, private readonly state: ReplayState, private readonly as: string | null) {}

  onMessage(message: JsonObject): void {
    this.state.received.push({ rpc: 'Write', as: this.as, message });
    const writes = (message.writes as Json[] | undefined) ?? [];
    const isHandshake = !this.handshaken;
    if (isHandshake) {
      this.handshaken = true;
      this.session.send({ streamId: this.state.tokens.opaque('stream'), streamToken: this.state.tokens.opaque('stream-token') });
      if (writes.length === 0) return;
    }
    if (writes.length === 0) {
      this.session.send({ streamToken: this.state.tokens.opaque('stream-token') });
      return;
    }
    this.answer(writes);
  }

  onClose(): void {}

  private answer(writes: Json[]): void {
    const exchange = this.state.take<WriteExchange>('write', this.as, (candidate) => matches(candidate.writes, writes));
    if (!exchange) {
      this.state.unmatched.push({ rpc: 'Write', as: this.as, request: writes });
      this.session.fail(NO_RECORDING(`write: ${JSON.stringify(writes)}`));
      return;
    }
    const context = this.state.context();
    if (exchange.error) {
      this.session.fail(exchange.error);
    } else {
      const response = fill(exchange.response ?? {}, context) as JsonObject;
      this.session.send({ ...response, streamToken: this.state.tokens.opaque('stream-token') });
    }
    this.state.writes.emit('answered', exchange.id, context.commitTime);
  }
}
