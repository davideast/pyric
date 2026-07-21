import type { LocalEnvironment } from 'pyric/sandbox/internal';
import type { QueryCursor, QueryOrderClause, QueryScope } from '../query-execution.js';
import type { AuthContext, Filter } from './types.js';
import { QueryImpl } from './query.js';
import { DocumentRefImpl } from './doc-ref.js';

type Cursor = QueryCursor;
type OrderClause = QueryOrderClause;

/** Cross-collection query plan for `Firestore.collectionGroup`. */
export class CollectionGroupQueryImpl extends QueryImpl {
  private readonly collectionId: string;

  constructor(
    env: LocalEnvironment,
    auth: AuthContext,
    collectionId: string,
    clauses: readonly Filter[] = [],
    orders: readonly OrderClause[] = [],
    limitCount?: number,
    limitFromEnd: boolean = false,
    start?: Cursor,
    end?: Cursor,
    bypassRules: boolean = false,
  ) {
    // The engine uses queryScope(), not the empty collectionPath.
    super(
      env,
      auth,
      '',
      clauses,
      orders,
      limitCount,
      limitFromEnd,
      start,
      end,
      bypassRules,
      (path) => new DocumentRefImpl(env, auth, path, bypassRules),
    );
    this.collectionId = collectionId;
  }

  /**
   * Subclass clone: hand back a fresh `CollectionGroupQueryImpl`
   * so chained calls (`where`, `applyFilter`, `orderBy`, `limit`,
   * `limitToLast`, cursors) preserve the cross-collection
   * identity. The base-class methods all dispatch through this
   * hook — no per-method overrides needed.
   */
  protected override clone(overrides: Partial<{
    clauses: readonly Filter[];
    orders: readonly OrderClause[];
    limitCount: number | undefined;
    limitFromEnd: boolean;
    start: Cursor | undefined;
    end: Cursor | undefined;
  }>): QueryImpl {
    return new CollectionGroupQueryImpl(
      this.env,
      this.auth,
      this.collectionId,
      overrides.clauses ?? this.clauses,
      overrides.orders ?? this.orders,
      'limitCount' in overrides ? overrides.limitCount : this.limitCount,
      overrides.limitFromEnd ?? this.limitFromEnd,
      'start' in overrides ? overrides.start : this.start,
      'end' in overrides ? overrides.end : this.end,
      this.bypassRules,
    );
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
