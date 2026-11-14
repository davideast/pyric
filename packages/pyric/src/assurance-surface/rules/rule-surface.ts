/**
 * Unified `RuleSurface` fact projection across Firestore, Realtime Database,
 * and Cloud Storage security rules.
 *
 * Keeps the three runtime rule evaluators completely uncoupled while giving
 * static passes (`static-query-proof`, `storage-contract`, `coverage-matrix`)
 * and dynamic probe generators one uniform `ResourcePattern`-keyed fact table.
 */
import type { FunctionDef, MatchBlock } from '../../rules/internal/index.js';
import {
  extractServiceHeader,
  normalizeExplicitResourceId,
} from '../../sandbox/internal/resource-pattern-header.js';
import {
  overlapsPattern,
  parseResourcePattern,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import type { StorageHttpHeaderKey } from '../code/types.js';
import { firestoreAllowOwnerConditions } from './firestore-owners.js';
import {
  normalizeRtdbSources,
  projectRtdbSource,
  rtdbValidateCoversTarget,
  violatesRtdbWildcardExclusions,
} from './rule-surface-rtdb.js';
import {
  expandRuleOps,
  formatMatchSegment,
  isOverbroadAuthOnlyRulesExpr,
  parseRulesAstWithMultiMatch,
  summarizeRulesGuard,
  type RuleAstScope,
} from './rules-ast-utils.js';
import { projectStorageRulesSource } from './storage-owners.js';
import type { OwnerCondition } from './types.js';
import { firestoreAllowValueHints, type ValueHint } from './value-hints.js';

export interface CrossServiceLookup {
  readonly targetService: 'firestore';
  readonly kind: 'get' | 'exists';
  readonly pattern: ResourcePattern;
  /** Field read on the looked-up doc, e.g. 'role' or 'members' in firestore.get(...).data.role */
  readonly field?: string;
  /** Positive scalar or list literal expected on `field`, e.g. `'editor'` or `['editor']`. */
  readonly expectedValue?: string | number | boolean | readonly (string | number | boolean)[];
  /** Relational operator when `expectedValue` was derived from `<`, `<=`, `>`, or `>=`. */
  readonly comparisonOp?: '<' | '<=' | '>' | '>=';
  /** Caller-identity expectation on `field`, e.g. `.data.ownerUid == request.auth.uid` or `!(request.auth.uid in .data.bannedUids)`. */
  readonly expectedAuth?: 'uid' | 'uid-list' | 'uid-not-in-list';
}

export interface StorageMetadataConstraint {
  readonly contentTypePattern?: string;
  /** Conjoined per-clause RE2 disjunctions (`&&` outer, `||` / `in [...]` inner). */
  readonly contentTypeConjuncts?: readonly (readonly string[])[];
  /** Inclusive minimum allowed object size in bytes (`> N` -> `N + 1`, `>= N` -> `N`, `== N` -> `N`). */
  readonly minSizeBytes?: number;
  /** Inclusive maximum allowed object size in bytes (`< N` -> `N - 1`, `<= N` -> `N`, `== N` -> `N`). */
  readonly maxSizeBytes?: number;
  readonly requiredCustomMetadataKeys?: readonly string[];
  readonly ownerMetadataKey?: string;
  /** Conjoined per-clause RE2 disjunctions on incoming `request.resource.<header>` fields. */
  readonly httpHeaders?: Readonly<
    Partial<Record<StorageHttpHeaderKey, readonly (readonly string[])[]>>
  >;
  /** Incoming HTTP headers explicitly required to be `null` (`request.resource.<header> == null`). */
  readonly nullHttpHeaders?: readonly StorageHttpHeaderKey[];
  /** Conjoined per-clause RE2 disjunctions on stored `resource.<header>` fields. */
  readonly storedHttpHeaders?: Readonly<
    Partial<Record<StorageHttpHeaderKey, readonly (readonly string[])[]>>
  >;
}

export interface StorageMetadataConstraintArm extends StorageMetadataConstraint {}

export interface RuleSurfaceEntry {
  readonly pattern: ResourcePattern;
  readonly ops: readonly string[];
  readonly ownerConditions: readonly OwnerCondition[];
  readonly valueHints: readonly ValueHint[];
  readonly declaredIndexes?: readonly string[];
  readonly storageMetadata?: StorageMetadataConstraint;
  readonly storageMetadataArms?: readonly StorageMetadataConstraintArm[];
  readonly crossServiceReads: readonly CrossServiceLookup[];
  readonly overbroadAuthOnlyWrite?: boolean;
  readonly wildcardBucket?: boolean;
  readonly wildcardDatabase?: boolean;
  readonly alwaysDeny?: boolean;
  readonly source: string;
}

export interface RuleSurface {
  readonly entries: readonly RuleSurfaceEntry[];
  matching(pattern: ResourcePattern, op?: string): readonly RuleSurfaceEntry[];
}

export interface FirestoreSurfaceSource {
  readonly source?: string;
  readonly text: string;
  readonly databaseId?: string;
  readonly database?: string;
  readonly modules?: Readonly<Record<string, string>>;
}

export interface RtdbSurfaceSource {
  readonly source?: string;
  readonly json: unknown;
  readonly instance?: string;
}

export interface StorageSurfaceSource {
  readonly source?: string;
  readonly text: string;
  readonly bucket?: string;
  readonly modules?: Readonly<Record<string, string>>;
}

export type FirestoreSurfaceInput =
  | string
  | FirestoreSurfaceSource
  | readonly (string | FirestoreSurfaceSource)[]
  | Readonly<Record<string, string>>;

export type RtdbSurfaceInput =
  | string
  | RtdbSurfaceSource
  | Readonly<Record<string, unknown>>
  | readonly (string | RtdbSurfaceSource)[]
  | Readonly<Record<string, string | Readonly<Record<string, unknown>>>>;

export type StorageSurfaceInput =
  | string
  | StorageSurfaceSource
  | readonly (string | StorageSurfaceSource)[]
  | Readonly<Record<string, string>>;

export interface ProjectRuleSurfaceInput {
  readonly firestore?: FirestoreSurfaceInput;
  readonly rtdb?: RtdbSurfaceInput;
  readonly storage?: StorageSurfaceInput;
}

const WRITE_OPS = new Set(['write', 'create', 'update', 'delete']);
const RTDB_NON_DELETE_WRITE_OPS = new Set([
  'create',
  'update',
  'set',
  'push',
  'onDisconnect.set',
  'onDisconnect.update',
]);

function normalizeFirestoreSources(
  input: FirestoreSurfaceInput | undefined,
): FirestoreSurfaceSource[] {
  if (input === undefined) return [];
  if (typeof input === 'string') return [{ source: 'firestore.rules', text: input }];
  if (Array.isArray(input)) {
    return input.map((item) => {
      if (typeof item === 'string') return { source: 'firestore.rules', text: item };
      return item;
    });
  }
  if (Object.hasOwn(input, 'text') && typeof (input as { text?: unknown }).text === 'string') {
    return [input as FirestoreSurfaceSource];
  }
  const out: FirestoreSurfaceSource[] = [];
  for (const [databaseId, text] of Object.entries(input as Readonly<Record<string, string>>)) {
    if (typeof text === 'string') {
      out.push({ source: `firestore:${databaseId}.rules`, text, databaseId });
    }
  }
  return out;
}

function normalizeStorageSources(input: StorageSurfaceInput | undefined): StorageSurfaceSource[] {
  if (input === undefined) return [];
  if (typeof input === 'string') return [{ source: 'storage.rules', text: input }];
  if (Array.isArray(input)) {
    return input.map((item) => {
      if (typeof item === 'string') return { source: 'storage.rules', text: item };
      return item;
    });
  }
  if (Object.hasOwn(input, 'text') && typeof (input as { text?: unknown }).text === 'string') {
    return [input as StorageSurfaceSource];
  }
  const out: StorageSurfaceSource[] = [];
  for (const [bucket, text] of Object.entries(input as Readonly<Record<string, string>>)) {
    if (typeof text === 'string') {
      out.push({ source: `storage:${bucket}.rules`, text, bucket });
    }
  }
  return out;
}

function projectFirestoreSource(item: FirestoreSurfaceSource): RuleSurfaceEntry[] {
  const file = item.source ?? 'firestore.rules';
  const parseOpts: {
    targetService: 'cloud.firestore';
    sourceFile: string;
    modules?: Readonly<Record<string, string>>;
  } = {
    targetService: 'cloud.firestore',
    sourceFile: file,
  };
  if (item.modules !== undefined) parseOpts.modules = item.modules;
  const services = parseRulesAstWithMultiMatch(item.text, parseOpts);
  const out: RuleSurfaceEntry[] = [];
  const targetDatabase = item.databaseId ?? item.database;
  const normalizedExplicitDb = normalizeExplicitResourceId('firestore', targetDatabase);

  const walk = (
    match: MatchBlock,
    parentSegments: readonly string[],
    functions: readonly (readonly FunctionDef[])[],
    wildcards: ReadonlySet<string>,
  ): void => {
    const fullPath = [...parentSegments];
    const nextWildcards = new Set(wildcards);
    for (const seg of match.path.segments) {
      fullPath.push(formatMatchSegment(seg));
      if (seg.type !== 'literal') nextWildcards.add(seg.name);
    }
    const scopeFns = [...functions, match.functions];
    const rawRulePath = `/${fullPath.join('/')}`;
    const header = extractServiceHeader('firestore', rawRulePath);
    if (
      normalizedExplicitDb !== undefined
      && header.headerKind === 'concrete'
      && header.headerResourceId !== normalizedExplicitDb
    ) {
      return;
    }

    const hasValidHeader = header.headerKind === 'concrete' || header.headerKind === 'wildcard';
    if (match.allows.length > 0 && hasValidHeader) {
      const pattern = parseResourcePattern('firestore', rawRulePath, targetDatabase);
      if (pattern.segments.length > 0) {
        const docPath = pattern.segments
          .map((seg) => {
            if (seg.kind === 'lit') return seg.text;
            if (seg.kind === 'rest') return `{${seg.name}=**}`;
            return `${seg.prefix ?? ''}{${seg.name}}${seg.suffix ?? ''}`;
          })
          .join('/');

        for (const allow of match.allows) {
          const ops = expandRuleOps(allow.operations);
          const line = allow.loc?.line ?? match.loc?.line;
          let ruleSource = file;
          if (line !== undefined) ruleSource = `${file}:${line}`;
          const ownerConditions = firestoreAllowOwnerConditions(
            allow,
            match.loc?.line,
            fullPath,
            scopeFns,
            nextWildcards,
            file,
          );
          const valueHints = firestoreAllowValueHints(
            allow.condition,
            scopeFns,
            docPath,
            nextWildcards,
          );
          const scope: RuleAstScope = {
            vars: new Map(),
            functions: scopeFns,
            wildcards: nextWildcards,
            depth: 0,
          };
          const entry: {
            pattern: ResourcePattern;
            ops: readonly string[];
            ownerConditions: readonly OwnerCondition[];
            valueHints: readonly ValueHint[];
            crossServiceReads: readonly CrossServiceLookup[];
            overbroadAuthOnlyWrite?: boolean;
            wildcardDatabase?: boolean;
            alwaysDeny?: boolean;
            source: string;
          } = {
            pattern,
            ops,
            ownerConditions,
            valueHints,
            crossServiceReads: [],
            source: ruleSource,
          };
          if (targetDatabase === undefined && header.headerKind === 'wildcard') {
            entry.wildcardDatabase = true;
          }
          if (ops.some((op) => WRITE_OPS.has(op))) {
            entry.overbroadAuthOnlyWrite = isOverbroadAuthOnlyRulesExpr(allow.condition, scope);
          }
          if (summarizeRulesGuard(allow.condition, scope, false) === 'impossible') {
            entry.alwaysDeny = true;
          }
          out.push(entry);
        }
      }
    }

    for (const child of match.children) {
      walk(child, fullPath, scopeFns, nextWildcards);
    }
  };

  for (const svc of services) {
    if (!/firestore/.test(svc.name)) continue;
    for (const topMatch of svc.matches) {
      walk(topMatch, [], svc.functions, new Set());
    }
  }
  return out;
}

function compatibleRuleVerbs(op: string): ReadonlySet<string> {
  switch (op) {
    case 'read':
      return new Set(['read', 'get', 'list']);
    case 'get':
    case 'getDoc':
    case 'getDownloadURL':
    case 'getBytes':
    case 'getBlob':
    case 'getStream':
    case 'getMetadata':
    case 'download':
      return new Set(['get', 'read']);
    case 'list':
    case 'query':
    case 'getDocs':
    case 'listAll':
    case 'getFiles':
      return new Set(['list', 'read']);
    case 'write':
      return new Set(['write', 'create', 'update', 'delete']);
    case 'create':
    case 'addDoc':
    case 'uploadBytes':
    case 'uploadBytesResumable':
    case 'uploadString':
    case 'save':
      return new Set(['create', 'write']);
    case 'update':
    case 'updateDoc':
    case 'updateMetadata':
    case 'setMetadata':
    case 'onDisconnect.update':
      return new Set(['update', 'write']);
    case 'setDoc':
    case 'set':
    case 'push':
    case 'transaction':
    case 'setPriority':
    case 'onDisconnect.set':
      return new Set(['create', 'update', 'write']);
    case 'delete':
    case 'deleteDoc':
    case 'remove':
    case 'onDisconnect.remove':
    case 'deleteObject':
    case 'deleteFiles':
      return new Set(['delete', 'write']);
    case 'validate':
      return new Set(['validate']);
    default:
      return new Set([op]);
  }
}

function entryCascades(entry: RuleSurfaceEntry): boolean {
  if (entry.pattern.service !== 'rtdb') return false;
  return entry.ops.includes('read') || entry.ops.includes('write');
}

export function projectRuleSurface(input: ProjectRuleSurfaceInput): RuleSurface {
  const entries: RuleSurfaceEntry[] = [];

  for (const fsSource of normalizeFirestoreSources(input.firestore)) {
    entries.push(...projectFirestoreSource(fsSource));
  }
  for (const rtdbSource of normalizeRtdbSources(input.rtdb)) {
    entries.push(...projectRtdbSource(rtdbSource));
  }
  for (const stSource of normalizeStorageSources(input.storage)) {
    entries.push(
      ...projectStorageRulesSource(
        stSource.text,
        stSource.source ?? 'storage.rules',
        stSource.bucket,
        stSource.modules,
      ),
    );
  }

  const explicitFirestoreDatabases = new Set<string>();
  const explicitStorageBuckets = new Set<string>();
  const rtdbAlwaysDenyValidates: RuleSurfaceEntry[] = [];
  for (const entry of entries) {
    if (
      entry.pattern.service === 'firestore'
      && !entry.wildcardDatabase
      && entry.pattern.resourceId !== '(default)'
    ) {
      explicitFirestoreDatabases.add(entry.pattern.resourceId);
    }
    if (
      entry.pattern.service === 'storage'
      && !entry.wildcardBucket
      && entry.pattern.resourceId !== '(default)'
    ) {
      explicitStorageBuckets.add(entry.pattern.resourceId);
    }
    if (
      entry.pattern.service === 'rtdb'
      && entry.alwaysDeny
      && entry.ops.includes('validate')
    ) {
      rtdbAlwaysDenyValidates.push(entry);
    }
  }

  return {
    entries,
    matching(pattern: ResourcePattern, op?: string): readonly RuleSurfaceEntry[] {
      let targetVerbs: ReadonlySet<string> | undefined;
      if (op !== undefined) targetVerbs = compatibleRuleVerbs(op);
      const rebindWildcardFirestore =
        pattern.service === 'firestore'
        && pattern.resourceId !== '(default)'
        && !explicitFirestoreDatabases.has(pattern.resourceId);
      const rebindWildcardStorage =
        pattern.service === 'storage'
        && pattern.resourceId !== '(default)'
        && !explicitStorageBuckets.has(pattern.resourceId);
      const matched = entries.filter((entry) => {
        if (targetVerbs !== undefined && !entry.ops.some((verb) => targetVerbs.has(verb))) {
          return false;
        }
        if (violatesRtdbWildcardExclusions(entry, pattern)) {
          return false;
        }
        let entryPattern = entry.pattern;
        if (
          rebindWildcardFirestore
          && entry.pattern.service === 'firestore'
          && entry.wildcardDatabase
        ) {
          entryPattern = { ...entry.pattern, resourceId: pattern.resourceId };
        }
        if (rebindWildcardStorage && entry.pattern.service === 'storage' && entry.wildcardBucket) {
          entryPattern = { ...entry.pattern, resourceId: pattern.resourceId };
        }
        return overlapsPattern(entryPattern, pattern, {
          cascadeA: entryCascades(entry),
          cascadeB: false,
        });
      });

      if (
        pattern.service === 'rtdb'
        && op !== undefined
        && RTDB_NON_DELETE_WRITE_OPS.has(op)
        && matched.length > 0
      ) {
        const blockingValidate = rtdbAlwaysDenyValidates.find((valEntry) =>
          rtdbValidateCoversTarget(valEntry, pattern),
        );
        if (blockingValidate !== undefined) {
          return [
            blockingValidate,
            ...matched.map((entry) => {
              if (entry.alwaysDeny) return entry;
              return { ...entry, alwaysDeny: true };
            }),
          ];
        }
      }

      return matched;
    },
  };
}
