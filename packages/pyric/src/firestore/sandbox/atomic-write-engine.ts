import type { DocStore } from './local-state.js';
import type { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import type { RulesState } from './rules-state.js';
import type { BatchOperationInput, BatchResult, Operation } from './writes.js';
import type { EventLog } from './event-log.js';
import type { FirestoreEventBus } from './event-bus.js';
import type { TriggerScope } from './trigger-scope.js';
import type {
  Transaction,
  TransactionOptions,
  TransactionResult,
} from './transaction-types.js';
import { AtomicWriteRuntime } from './atomic-write-runtime.js';
import { BatchWriteExecutor } from './batch-write-executor.js';
import { TransactionWriteExecutor } from './transaction-write-executor.js';

interface AtomicWriteEngineHost {
  readonly state: DocStore;
  notifyListenersForPaths(paths: Set<string>): void;
}

/** Coordinates atomic batch and transaction writes behind WriteEngine. */
export class AtomicWriteEngine {
  private readonly batches: BatchWriteExecutor;
  private readonly transactions: TransactionWriteExecutor;

  constructor(
    host: AtomicWriteEngineHost,
    rules: RulesState,
    simulator: SimulateFirestoreRulesHandler,
    eventLog: EventLog,
    events: FirestoreEventBus,
    triggerScope: TriggerScope,
  ) {
    const runtime = new AtomicWriteRuntime(
      host,
      rules,
      simulator,
      eventLog,
      events,
      triggerScope,
    );
    this.batches = new BatchWriteExecutor(runtime);
    this.transactions = new TransactionWriteExecutor(runtime);
  }

  batch(
    operations: BatchOperationInput[],
    auth: Operation['auth'],
    bypassRules?: boolean,
  ): BatchResult {
    return this.batches.batch(operations, auth, bypassRules);
  }

  transaction<R>(
    fn: (tx: Transaction) => Promise<R>,
    options: TransactionOptions,
  ): Promise<TransactionResult<R>>;
  transaction<R>(
    fn: (tx: Transaction) => R,
    options: TransactionOptions,
  ): TransactionResult<R>;
  transaction<R>(
    fn: (tx: Transaction) => R | Promise<R>,
    options: TransactionOptions,
  ): TransactionResult<R> | Promise<TransactionResult<R>> {
    return this.transactions.transaction(
      fn as (tx: Transaction) => R,
      options,
    ) as TransactionResult<R> | Promise<TransactionResult<R>>;
  }
}
