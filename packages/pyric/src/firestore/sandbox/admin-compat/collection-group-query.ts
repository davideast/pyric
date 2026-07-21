import type { QueryScope } from '../query-execution.js';
import { QueryImpl, type QueryState, type QueryStatePatch } from './query.js';
import { createDocumentRef } from './collection-ref.js';

interface CollectionGroupQueryState extends Omit<QueryState, 'collectionPath' | 'documentRef'> {
  collectionId: string;
}

/** Cross-collection query plan for `Firestore.collectionGroup`. */
export class CollectionGroupQueryImpl extends QueryImpl {
  private readonly collectionId: string;

  constructor(state: CollectionGroupQueryState) {
    // The engine uses queryScope(), not the empty collectionPath.
    super({
      ...state,
      collectionPath: '',
      documentRef: (path) => createDocumentRef(
        state.env,
        state.auth,
        path,
        state.bypassRules ?? false,
      ),
    });
    this.collectionId = state.collectionId;
  }

  /**
   * Subclass clone: hand back a fresh `CollectionGroupQueryImpl`
   * so chained calls (`where`, `applyFilter`, `orderBy`, `limit`,
   * `limitToLast`, cursors) preserve the cross-collection
   * identity. The base-class methods all dispatch through this
   * hook — no per-method overrides needed.
   */
  protected override clone(overrides: QueryStatePatch): QueryImpl {
    return new CollectionGroupQueryImpl({
      env: this.env,
      auth: this.auth,
      collectionId: this.collectionId,
      clauses: overrides.clauses ?? this.clauses,
      orders: overrides.orders ?? this.orders,
      limitCount: 'limitCount' in overrides ? overrides.limitCount : this.limitCount,
      limitFromEnd: overrides.limitFromEnd ?? this.limitFromEnd,
      start: 'start' in overrides ? overrides.start : this.start,
      end: 'end' in overrides ? overrides.end : this.end,
      bypassRules: this.bypassRules,
    });
  }

  /** Describe the collection-group scope gathered by RulesReadEngine. */
  protected override queryScope(): QueryScope {
    return { kind: 'collection-group', collectionId: this.collectionId };
  }

  /**
   * Group reads span many parent collections, so there's no single
   * concrete collection path to evaluate the `list` rule against. Use
   * the group id as the representative match path for the list proof.
   */
  protected override listRulePath(): string {
    return this.collectionId;
  }

  protected override activityScope(): unknown {
    return { kind: 'collection-group' };
  }
}
