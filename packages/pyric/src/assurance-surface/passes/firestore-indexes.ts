/**
 * Stateless pass over {@link SdkUsageIndex} producing `firestore.indexes.json`
 * composite index definitions, per-collection shape signals, and resolution
 * warnings.
 */
import { indexEntryKey, needsCompositeIndex, shapeToIndexEntry } from '../../indexes/extract/composite.js';
import type {
  ExtractionSignal,
  ExtractionWarning,
  Filter,
  Order,
  QueryShape,
} from '../../indexes/extract/types.js';
import type { IndexesConfig, IndexesConfigEntry } from '../../indexes/types.js';
import { renderResourcePattern } from '../../sandbox/internal/resource-pattern.js';
import type {
  SdkQuery,
  SdkQueryConstraint,
  SdkUsageIndex,
} from '../code/usage-index.js';
import { formatSourceAtLine, splitSourceLocation } from './source-location.js';

const OVERSHOOT_THRESHOLD = 3;
const MAX_DNF_ARMS = 32;
const RECOGNIZED_NON_FIELD_CONSTRAINTS = new Set([
  'limit',
  'limitToLast',
  'startAt',
  'startAfter',
  'endAt',
  'endBefore',
]);

export interface FirestoreIndexPassOptions {
  /** Scope extracted shapes and composite indexes to one Firestore database (`resourceId`). */
  readonly databaseId?: string;
}

export interface FirestoreIndexPassResult {
  readonly config: IndexesConfig;
  readonly byDatabase: Readonly<Record<string, IndexesConfig>>;
  readonly signals: ExtractionSignal[];
  readonly warnings: ExtractionWarning[];
  readonly shapesEnumerated: number;
}

function shapeKey(shape: QueryShape): string {
  const scope = shape.isCollectionGroup ? 'G' : 'C';
  const filters = shape.filters.map((f) => `${f.field}${f.op}`).join(',');
  const orders = shape.orders.map((o) => `${o.field}:${o.direction}`).join(',');
  const limit = shape.limit ?? '-';
  return `${scope}:${shape.collectionPath}|${filters}|${orders}|L=${limit}`;
}

function isUnresolvedConstraint(constraint: SdkQueryConstraint): boolean {
  if (constraint.kind === 'unknown') return true;
  if (constraint.kind === 'where') {
    return constraint.field === undefined || constraint.op === undefined;
  }
  if (constraint.kind === 'orderBy') {
    return constraint.field === undefined;
  }
  if (constraint.kind === 'and' || constraint.kind === 'or') {
    return false;
  }
  return !RECOGNIZED_NON_FIELD_CONSTRAINTS.has(constraint.kind);
}

function collectUnknownConstraintKeys(
  constraints: readonly SdkQueryConstraint[],
  seen: Set<string>,
): void {
  for (const constraint of constraints) {
    if (constraint.kind === 'and' || constraint.kind === 'or') {
      collectUnknownConstraintKeys(constraint.children ?? [], seen);
      continue;
    }
    if (isUnresolvedConstraint(constraint)) {
      seen.add(`${constraint.kind}:${constraint.field ?? '?'}:${constraint.op ?? '?'}`);
    }
  }
}

function expandConstraintArms(constraint: SdkQueryConstraint): SdkQueryConstraint[][] {
  if (constraint.kind === 'and') {
    return expandSequenceArms(constraint.children ?? []);
  }
  if (constraint.kind === 'or') {
    const children = constraint.children ?? [];
    if (children.length === 0) return [[]];
    const arms: SdkQueryConstraint[][] = [];
    for (const child of children) {
      for (const arm of expandConstraintArms(child)) {
        if (arms.length >= MAX_DNF_ARMS) break;
        arms.push(arm);
      }
      if (arms.length >= MAX_DNF_ARMS) break;
    }
    return arms;
  }
  return [[constraint]];
}

function expandSequenceArms(sequence: readonly SdkQueryConstraint[]): SdkQueryConstraint[][] {
  let arms: SdkQueryConstraint[][] = [[]];
  for (const item of sequence) {
    const choices = expandConstraintArms(item);
    const next: SdkQueryConstraint[][] = [];
    for (const prefix of arms) {
      for (const choice of choices) {
        if (next.length >= MAX_DNF_ARMS) break;
        next.push([...prefix, ...choice]);
      }
      if (next.length >= MAX_DNF_ARMS) break;
    }
    arms = next;
  }
  return arms;
}

function armToShape(
  collectionPath: string,
  isCollectionGroup: boolean,
  arm: readonly SdkQueryConstraint[],
): QueryShape {
  const filters: Filter[] = [];
  const orders: Order[] = [];
  let limit: number | null = null;
  for (const c of arm) {
    if (c.kind === 'where' && c.field !== undefined && c.op !== undefined) {
      filters.push({ field: c.field, op: c.op });
    } else if (c.kind === 'orderBy' && c.field !== undefined) {
      orders.push({ field: c.field, direction: c.direction ?? 'asc' });
    } else if (
      (c.kind === 'limit' || c.kind === 'limitToLast')
      && c.operand?.kind === 'literal'
      && typeof c.operand.literal === 'number'
    ) {
      limit = c.operand.literal;
    }
  }
  return { collectionPath, isCollectionGroup, filters, orders, limit };
}

function enumerateQueryShapes(
  query: SdkQuery,
  collectionPath: string,
  isCollectionGroup: boolean,
): { shapes: QueryShape[]; unknownCount: number } {
  const branches = query.branches ?? [query.constraints];
  const unknownKeys = new Set<string>();
  const seenShapes = new Set<string>();
  const shapes: QueryShape[] = [];

  for (const branch of branches) {
    collectUnknownConstraintKeys(branch, unknownKeys);
    for (const arm of expandSequenceArms(branch)) {
      const shape = armToShape(collectionPath, isCollectionGroup, arm);
      const key = shapeKey(shape);
      if (seenShapes.has(key)) continue;
      seenShapes.add(key);
      shapes.push(shape);
    }
  }

  return { shapes, unknownCount: unknownKeys.size };
}

function buildSignals(shapes: readonly QueryShape[]): ExtractionSignal[] {
  const groups = new Map<string, QueryShape[]>();
  for (const shape of shapes) {
    const cg = shape.collectionPath.split('/').pop() || shape.collectionPath;
    let bucket = groups.get(cg);
    if (!bucket) {
      bucket = [];
      groups.set(cg, bucket);
    }
    bucket.push(shape);
  }

  const signals: ExtractionSignal[] = [];
  for (const [collectionGroup, bucket] of groups) {
    const fields = new Set<string>();
    for (const shape of bucket) {
      for (const f of shape.filters) fields.add(f.field);
      for (const o of shape.orders) fields.add(o.field);
    }
    signals.push({
      collectionGroup,
      shapeCount: bucket.length,
      fieldsTouched: [...fields].sort(),
      overshootSuspected: bucket.length > OVERSHOOT_THRESHOLD,
    });
  }
  signals.sort((a, b) => a.collectionGroup.localeCompare(b.collectionGroup));
  return signals;
}

function shapesToIndexes(shapes: readonly QueryShape[]): IndexesConfigEntry[] {
  const seen = new Set<string>();
  const entries: IndexesConfigEntry[] = [];
  for (const shape of shapes) {
    if (!needsCompositeIndex(shape)) continue;
    const entry = shapeToIndexEntry(shape);
    if (entry.fields.length < 2) continue;
    const key = indexEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

function appendWarning(
  warnings: ExtractionWarning[],
  file: string,
  line: number | undefined,
  code: ExtractionWarning['code'],
  message: string,
): void {
  const warning: ExtractionWarning = { file, code, message };
  if (line !== undefined) warning.line = line;
  warnings.push(warning);
}

export function firestoreIndexPass(
  usage: SdkUsageIndex,
  options?: FirestoreIndexPassOptions,
): FirestoreIndexPassResult {
  const allShapes: QueryShape[] = [];
  const shapesByDb = new Map<string, QueryShape[]>();
  const warnings: ExtractionWarning[] = [];

  for (const q of usage.queries) {
    const pattern = q.baseRef.pattern;
    if (pattern.service !== 'firestore') continue;
    if (options?.databaseId !== undefined && pattern.resourceId !== options.databaseId) {
      continue;
    }

    const { file, line } = splitSourceLocation(q.source);
    const atLine = formatSourceAtLine(line);
    if (q.baseRef.refKind === 'doc') {
      appendWarning(
        warnings,
        file,
        line,
        'unresolved-query',
        `Call to query(...)${atLine} received a document reference instead of collection(...) or collectionGroup(...); no index was generated.`,
      );
      continue;
    }
    if (q.baseRef.resolution === 'unresolved' || pattern.segments.length === 0) {
      appendWarning(
        warnings,
        file,
        line,
        'unresolved-query',
        `Call to query(...)${atLine} could not resolve a literal collection(...) or collectionGroup(...) base (${q.baseRef.reason ?? 'unresolved'}); no index was generated.`,
      );
      continue;
    }

    const leaf = pattern.segments[pattern.segments.length - 1];
    const hasUntracedGroupId = q.baseRef.reason?.includes('collection group id ') === true;
    if (!leaf || leaf.kind !== 'lit' || hasUntracedGroupId) {
      const rendered = renderResourcePattern(pattern);
      appendWarning(
        warnings,
        file,
        line,
        'dynamic-collection-id',
        `Query on '${rendered}': index for a wildcard collection id skipped: name the collection.`,
      );
      continue;
    }

    const isCollectionGroup = q.baseRef.refKind === 'collectionGroup';
    let collectionPath = leaf.text;
    if (!isCollectionGroup) {
      collectionPath = renderResourcePattern(pattern);
    }
    const { shapes, unknownCount } = enumerateQueryShapes(q, collectionPath, isCollectionGroup);

    if (unknownCount > 0) {
      appendWarning(
        warnings,
        file,
        line,
        'unknown-callee',
        `Query on '${collectionPath}' contained ${unknownCount} unrecognized or non-literal constraint call(s); those constraints were skipped.`,
      );
    }

    allShapes.push(...shapes);
    let dbShapes = shapesByDb.get(pattern.resourceId);
    if (!dbShapes) {
      dbShapes = [];
      shapesByDb.set(pattern.resourceId, dbShapes);
    }
    dbShapes.push(...shapes);
  }

  const byDatabase: Record<string, IndexesConfig> = Object.create(null) as Record<
    string,
    IndexesConfig
  >;
  const sortedDbIds = [...shapesByDb.keys()].sort();
  for (const dbId of sortedDbIds) {
    byDatabase[dbId] = { indexes: shapesToIndexes(shapesByDb.get(dbId) ?? []) };
  }

  return {
    config: { indexes: shapesToIndexes(allShapes) },
    byDatabase,
    signals: buildSignals(allShapes),
    warnings,
    shapesEnumerated: allShapes.length,
  };
}
