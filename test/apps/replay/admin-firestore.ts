// The Firestore RPCs the Admin SDK (`@google-cloud/firestore`) sends over
// gRPC, answered from `admin-firestore` exchanges (`format.ts`). `grpc.ts`
// decodes each request into proto3 JSON and encodes each answer back.
//
// A request matches an exchange for the same RPC when it equals the recorded
// request, with placeholders. The first matching exchange not yet used
// answers it, or the last matching one when all are used, as a client
// stream's are. A request no exchange holds is listed in `unmatched` and
// refused, so the Admin call fails.
//
// State: the transaction ids this server issued and has not closed. A
// `{ "$": "transaction" }` in an answer (BeginTransaction, or the first read
// of a lazily started transaction) issues a new id; in a request it matches
// only an open id. Commit and Rollback close the id they name. Read, commit
// and resume values are filled from the shared clock and tokens, so times
// only move forward across the Admin and client streams. A Commit's answer
// releases the Listen batches that name it, on Admin and client streams alike.
import { placeholderName, type AdminFirestoreExchange, type AdminFirestoreRpc, type Json, type JsonObject } from './format.ts';
import { targetShape, type ReplayState, type StreamSession } from './firestore.ts';
import { fill, matches } from './values.ts';
import type { StreamHandler } from './webchannel.ts';

/** An answer for one Admin RPC: messages sent in order, then a final status when it failed. */
export interface AdminAnswer {
  responses: JsonObject[];
  error?: { code: number; status: string; message: string };
}

type AdminCallRpc = Exclude<AdminFirestoreRpc, 'Listen'>;

const TRANSACTION: JsonObject = { $: 'transaction' };
const CLOSES_TRANSACTION: ReadonlySet<AdminCallRpc> = new Set(['Commit', 'Rollback']);

/** Whether an answer value issues a transaction: the `transaction` placeholder. */
function isTransactionPlaceholder(value: Json | undefined): boolean {
  return placeholderName(value) === 'transaction';
}

export class AdminFirestore {
  private readonly used = new Set<string>();
  private readonly open = new Set<string>();

  constructor(private readonly state: ReplayState) {}

  /** The recorded answer to one Admin RPC, or null (listed in `unmatched`) when no exchange holds it. */
  answer(rpc: AdminCallRpc, request: JsonObject): AdminAnswer | null {
    const openId = this.openTransaction(request.transaction);
    const shape = openId === null ? request : { ...request, transaction: TRANSACTION };
    const exchange = this.take(rpc, shape);
    if (!exchange) {
      this.refuse(rpc);
      return null;
    }
    if (openId !== null && CLOSES_TRANSACTION.has(rpc)) this.open.delete(openId);
    const context = this.state.context();
    const responses = (exchange.responses ?? []).map((response) => fill(this.issueTransactions(response), context) as JsonObject);
    if (rpc === 'Commit') this.state.writes.emit('answered', exchange.id, context.commitTime);
    return exchange.error ? { responses, error: exchange.error } : { responses };
  }

  /** A Listen stream from the Admin SDK, answered from its `Listen` exchanges. */
  listen(session: StreamSession): StreamHandler {
    return new AdminListen(session, this.state, (shape) => this.take('Listen', shape));
  }

  /** Lists an RPC no exchange answers. The request is named by its method, as the other unrecorded RPCs are. */
  refuse(rpc: AdminFirestoreRpc): void {
    this.state.unmatched.push({ rpc: 'grpc', as: null, request: { method: rpc } });
  }

  /** The id a request names when this server issued it and has not closed it, else null. */
  private openTransaction(value: Json | undefined): string | null {
    return typeof value === 'string' && this.open.has(value) ? value : null;
  }

  private take(rpc: AdminFirestoreRpc, request: JsonObject): AdminFirestoreExchange | null {
    const candidates = this.state.recordings
      .flatMap((recording) => recording.exchanges)
      .filter((exchange): exchange is AdminFirestoreExchange => exchange.kind === 'admin-firestore' && exchange.rpc === rpc)
      .filter((exchange) => matches(exchange.request, request));
    const chosen = candidates.find((exchange) => !this.used.has(exchange.id)) ?? candidates.at(-1) ?? null;
    if (chosen) this.used.add(chosen.id);
    return chosen;
  }

  /** A copy of `response` with each top-level `transaction` placeholder replaced by a newly issued id. */
  private issueTransactions(response: JsonObject): JsonObject {
    if (!isTransactionPlaceholder(response.transaction)) return response;
    const id = this.state.tokens.opaque('transaction');
    this.open.add(id);
    return { ...response, transaction: id };
  }
}

/**
 * The Admin SDK's Listen stream: one target (`targetId` 1), whose first batch
 * is sent at once and each later batch when the Commit it names is answered.
 * After every batch, a target change with a read time and no target ids marks
 * the snapshot consistent, as production sends. A target no exchange holds is
 * removed with a FAILED_PRECONDITION cause, so the listener fails.
 */
class AdminListen implements StreamHandler {
  private readonly stops: Array<() => void> = [];

  constructor(
    private readonly session: StreamSession,
    private readonly state: ReplayState,
    private readonly take: (shape: JsonObject) => AdminFirestoreExchange | null,
  ) {}

  onMessage(message: JsonObject): void {
    const addTarget = message.addTarget as JsonObject | undefined;
    if (addTarget) this.add(addTarget);
  }

  onClose(): void {
    for (const stop of this.stops) stop();
    this.stops.length = 0;
  }

  private add(addTarget: JsonObject): void {
    const targetId = addTarget.targetId as number;
    const shape = targetShape(addTarget);
    const exchange = this.take(shape);
    if (!exchange) {
      this.state.unmatched.push({ rpc: 'grpc', as: null, request: { method: 'Listen' } });
      const cause = { code: 9, message: `pyric replay has no recorded exchange for this Admin target: ${JSON.stringify(shape)}` };
      this.session.send({ targetChange: { targetChangeType: 'REMOVE', targetIds: [targetId], cause } });
      return;
    }
    const [first, ...later] = exchange.batches ?? [];
    if (first) this.sendBatch(first.messages, targetId);
    const onAnswered = (writeId: string, commitTime: string | undefined) => {
      for (const batch of later.filter((candidate) => candidate.after === writeId)) this.sendBatch(batch.messages, targetId, commitTime);
    };
    this.state.writes.on('answered', onAnswered);
    this.stops.push(() => this.state.writes.off('answered', onAnswered));
  }

  private sendBatch(messages: JsonObject[], targetId: number, commitTime?: string): void {
    const context = this.state.context({ targetId, commitTime });
    for (const message of messages) this.session.send(fill(message, context) as JsonObject);
    this.session.send({ targetChange: { readTime: this.state.clock.next() } });
  }
}
