import { type DocStore, type DocumentData } from './local-state.js';
import { partitionDeletes } from './value-resolver.js';
import { makeError, type FirestoreSimError } from './errors.js';
import type { TestCase, TestFirestoreRulesResult } from 'pyric/rules/internal';
import { SimulateFirestoreRulesHandler, Timestamp } from 'pyric/rules/internal';
import { RulesState } from './rules-state.js';
import { adminBypassResult, isoFromTimestamp } from './rules-evaluation.js';
import type { Operation } from './writes.js';

export interface WriteEngineHost {
  readonly state: DocStore;
}

/** Rules-aware Firestore write policy behind the stable LocalEnvironment facade. */
export class WriteEngine {
  constructor(
    private readonly host: WriteEngineHost,
    private readonly rules: RulesState,
    private readonly simulator: SimulateFirestoreRulesHandler,
  ) {}

  capturePriors(paths: readonly string[]): Record<string, DocumentData | null> {
    const priors: Record<string, DocumentData | null> = {};
    for (const path of paths) {
      const prior = this.host.state.get(path);
      priors[path] = prior ? { ...prior } : null;
    }
    return priors;
  }

  runSimulate(
    testCases: TestCase[],
    bypassRules: boolean | undefined,
    batchProjection?: Map<string, DocumentData | null>,
  ): TestFirestoreRulesResult {
    if (bypassRules) {
      const results = testCases.map((tc) => adminBypassResult(tc.description));
      return {
        success: true,
        data: { passed: results.length, failed: 0, unsupported: 0, results },
      };
    }
    return this.simulator.simulate(this.rules.source, testCases, {
      getDoc: (path) => this.host.state.get(path),
      ...(batchProjection ? { batchProjection } : {}),
    });
  }

  buildBatchProjection(testCases: TestCase[]): Map<string, DocumentData | null> {
    const projection = new Map<string, DocumentData | null>();
    for (const testCase of testCases) {
      if (testCase.method === 'get' || testCase.method === 'list') continue;
      projection.set(
        testCase.path,
        testCase.method === 'delete' ? null : (testCase.data ?? {}),
      );
    }
    return projection;
  }

  buildTestCase(operation: Operation, serverTime?: Timestamp): TestCase {
    const existingDoc = this.host.state.get(operation.path);
    const ruleMethod: TestCase['method'] = operation.method === 'set'
      ? (existingDoc !== null ? 'update' : 'create')
      : (operation.method as TestCase['method']);

    let requestData = operation.data;
    if (operation.method === 'get' || operation.method === 'list') {
      requestData = undefined;
    } else if (operation.method === 'update' && existingDoc && operation.data) {
      const { writes, deletedKeys } = partitionDeletes(operation.data);
      const merged: DocumentData = { ...existingDoc, ...writes };
      for (const key of deletedKeys) delete merged[key];
      requestData = merged;
    } else if (operation.data) {
      requestData = partitionDeletes(operation.data).writes;
    }

    return {
      description: `${operation.method} ${operation.path}`,
      expectation: 'ALLOW',
      method: ruleMethod,
      path: operation.path,
      auth: operation.auth ? { uid: operation.auth.uid, token: operation.auth.token } : null,
      data: requestData,
      resource: existingDoc ?? undefined,
      ...(serverTime ? { requestTime: isoFromTimestamp(serverTime) } : {}),
    };
  }

  applyWrite(
    method: string,
    path: string,
    data?: DocumentData,
    merge?: boolean | { mergeFields: readonly string[] },
  ): FirestoreSimError | null {
    if (merge !== undefined && merge !== false && (method === 'create' || method === 'update')) {
      const mergeFields = merge === true ? undefined : merge.mergeFields;
      this.host.state.setMerge(path, data ?? {}, mergeFields);
      return null;
    }
    switch (method) {
      case 'create': {
        const result = this.host.state.create(path, data ?? {});
        if (!result.success) {
          return makeError('already-exists', result.error ?? `Document '${path}' already exists`);
        }
        return null;
      }
      case 'update': {
        const result = this.host.state.update(path, data ?? {});
        if (!result.success) {
          return makeError('not-found', result.error ?? `Document '${path}' does not exist`);
        }
        return null;
      }
      case 'set':
        this.host.state.set(path, data ?? {});
        return null;
      case 'delete':
        this.host.state.delete(path);
        return null;
      default:
        return null;
    }
  }
}
