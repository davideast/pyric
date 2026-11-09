/**
 * Unified `RuleSurface` fact projection across Firestore, Realtime Database,
 * and Cloud Storage security rules.
 *
 * Keeps the three runtime rule evaluators completely uncoupled while giving
 * static passes (`static-query-proof`, `storage-contract`, `coverage-matrix`)
 * and dynamic probe generators one uniform `ResourcePattern`-keyed fact table.
 */
import type { FunctionDef, MatchBlock } from '../../rules/internal/index.js';
import { parseRtdbExpressionTree, toStrictRulesJson } from '../../rules/internal/rtdb.js';
import {
  extractServiceHeader,
  normalizeExplicitResourceId,
} from '../../sandbox/internal/resource-pattern-header.js';
import {
  overlapsPattern,
  parseResourcePattern,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import { firestoreAllowOwnerConditions } from './firestore-owners.js';
import { rtdbExpressionOwnerConditions } from './rtdb-owners.js';
import {
  expandRuleOps,
  formatMatchSegment,
  isOverbroadAuthOnlyRtdbExpr,
  isOverbroadAuthOnlyRulesExpr,
  parseRulesAstWithMultiMatch,
  summarizeRtdbGuard,
  summarizeRulesGuard,
  type RuleAstScope,
} from './rules-ast-utils.js';
import { projectStorageRulesSource } from './storage-owners.js';
import type { OwnerCondition } from './types.js';
import {
  firestoreAllowValueHints,
  rtdbExpressionValueHints,
  type ValueHint,
} from './value-hints.js';

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
  /** Inclusive maximum allowed object size in bytes (`< N` -> `N - 1`, `<= N` -> `N`). */
  readonly maxSizeBytes?: number;
  readonly requiredCustomMetadataKeys?: readonly string[];
  readonly ownerMetadataKey?: string;
}

export interface RuleSurfaceEntry {
  readonly pattern: ResourcePattern;
  readonly ops: readonly string[];
  readonly ownerConditions: readonly OwnerCondition[];
  readonly valueHints: readonly ValueHint[];
  readonly declaredIndexes?: readonly string[];
  readonly storageMetadata?: StorageMetadataConstraint;
  readonly crossServiceReads: readonly CrossServiceLookup[];
  readonly overbroadAuthOnlyWrite?: boolean;
  readonly wildcardBucket?: boolean;
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

type RtdbWildcardExclusions = ReadonlyMap<number, ReadonlySet<string>>;
const RTDB_WILDCARD_EXCLUSIONS = new WeakMap<RuleSurfaceEntry, RtdbWildcardExclusions>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeFirestoreSources(input: FirestoreSurfaceInput | undefined): FirestoreSurfaceSource[] {
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

function parseMaybeRtdbJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(toStrictRulesJson(raw));
  } catch {
    return null;
  }
}

function normalizeRtdbSources(input: RtdbSurfaceInput | undefined): RtdbSurfaceSource[] {
  if (input === undefined) return [];
  if (typeof input === 'string') {
    return [{ source: 'database.rules.json', json: parseMaybeRtdbJson(input) }];
  }
  if (Array.isArray(input)) {
    return input.map((item) => {
      if (typeof item === 'string') {
        return { source: 'database.rules.json', json: parseMaybeRtdbJson(item) };
      }
      return {
        source: item.source ?? 'database.rules.json',
        json: parseMaybeRtdbJson(item.json),
        instance: item.instance,
      };
    });
  }
  if (Object.hasOwn(input, 'json') && (input as { json?: unknown }).json !== undefined) {
    const desc = input as RtdbSurfaceSource;
    return [{
      source: desc.source ?? 'database.rules.json',
      json: parseMaybeRtdbJson(desc.json),
      instance: desc.instance,
    }];
  }
  const keys = Object.keys(input);
  if (keys.length === 1 && keys[0] === 'rules' && isPlainObject((input as { rules?: unknown }).rules)) {
    return [{ source: 'database.rules.json', json: input }];
  }
  const out: RtdbSurfaceSource[] = [];
  for (const [instance, raw] of Object.entries(input)) {
    out.push({
      source: `database:${instance}.rules.json`,
      json: parseMaybeRtdbJson(raw),
      instance,
    });
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
  const services = parseRulesAstWithMultiMatch(item.text);
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
          const valueHints = firestoreAllowValueHints(allow.condition, scopeFns, docPath, nextWildcards);
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

function parseDeclaredIndexes(raw: unknown): string[] | undefined {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) {
    const valid = raw.filter((x): x is string => typeof x === 'string');
    return valid;
  }
  return undefined;
}

function dedupeValueHints(hints: readonly ValueHint[]): ValueHint[] {
  const seen = new Set<string>();
  const out: ValueHint[] = [];
  for (const h of hints) {
    const key = `${h.service}|${h.path}|${h.field}|${typeof h.value}:${String(h.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

function projectRtdbSource(item: RtdbSurfaceSource): RuleSurfaceEntry[] {
  const file = item.source ?? 'database.rules.json';
  let root: unknown;
  if (isPlainObject(item.json)) root = item.json.rules;
  if (!isPlainObject(root)) return [];
  const out: RuleSurfaceEntry[] = [];

  const walk = (
    node: Record<string, unknown>,
    path: readonly string[],
    exclusions: RtdbWildcardExclusions,
  ): void => {
    const rawPath = path.join('/');
    const pattern = parseResourcePattern('rtdb', rawPath, item.instance);
    let rawIndexOn: unknown;
    if (Object.hasOwn(node, '.indexOn')) rawIndexOn = node['.indexOn'];
    const declaredIndexes = parseDeclaredIndexes(rawIndexOn);

    let validateHints: ValueHint[] = [];
    if (Object.hasOwn(node, '.validate') && typeof node['.validate'] === 'string') {
      const parsedVal = parseRtdbExpressionTree(node['.validate']);
      if (parsedVal.ok) {
        validateHints = rtdbExpressionValueHints(parsedVal.tree, rawPath);
      }
    }

    let emittedRuleOnNode = false;
    for (const [ruleKey, opName] of [
      ['.read', 'read'],
      ['.write', 'write'],
      ['.validate', 'validate'],
    ] as const) {
      if (!Object.hasOwn(node, ruleKey)) continue;
      const exprText = node[ruleKey];
      if (typeof exprText !== 'string' && typeof exprText !== 'boolean') continue;
      const normalizedExpr = String(exprText);
      const parsed = parseRtdbExpressionTree(normalizedExpr);
      const entrySource = `${file}#/rules/${[...path, ruleKey].join('/')}`;
      let ownerConditions: OwnerCondition[] = [];
      let valueHints: ValueHint[] = [];
      let overbroad: boolean | undefined;
      let alwaysDeny: boolean | undefined;

      if (parsed.ok) {
        if (summarizeRtdbGuard(parsed.tree, false) === 'impossible') {
          alwaysDeny = true;
        }
        ownerConditions = rtdbExpressionOwnerConditions(parsed.tree, path, opName, entrySource);
        if (opName === 'write') {
          valueHints = dedupeValueHints([
            ...rtdbExpressionValueHints(parsed.tree, rawPath),
            ...validateHints,
          ]);
          overbroad = isOverbroadAuthOnlyRtdbExpr(parsed.tree);
        } else if (opName === 'validate') {
          valueHints = validateHints;
        }
      } else if (opName === 'write') {
        overbroad = false;
      }

      const entry: {
        pattern: ResourcePattern;
        ops: readonly string[];
        ownerConditions: readonly OwnerCondition[];
        valueHints: readonly ValueHint[];
        declaredIndexes?: readonly string[];
        crossServiceReads: readonly CrossServiceLookup[];
        overbroadAuthOnlyWrite?: boolean;
        alwaysDeny?: boolean;
        source: string;
      } = {
        pattern,
        ops: [opName],
        ownerConditions,
        valueHints,
        crossServiceReads: [],
        source: entrySource,
      };
      if (declaredIndexes !== undefined) entry.declaredIndexes = declaredIndexes;
      if (overbroad !== undefined) entry.overbroadAuthOnlyWrite = overbroad;
      if (alwaysDeny !== undefined) entry.alwaysDeny = alwaysDeny;
      if (exclusions.size > 0) RTDB_WILDCARD_EXCLUSIONS.set(entry, exclusions);
      out.push(entry);
      emittedRuleOnNode = true;
    }

    if (!emittedRuleOnNode && declaredIndexes !== undefined) {
      const indexEntry: RuleSurfaceEntry = {
        pattern,
        ops: [],
        ownerConditions: [],
        valueHints: [],
        declaredIndexes,
        crossServiceReads: [],
        source: `${file}#/rules/${[...path, '.indexOn'].join('/')}`,
      };
      if (exclusions.size > 0) RTDB_WILDCARD_EXCLUSIONS.set(indexEntry, exclusions);
      out.push(indexEntry);
    }

    const literalChildren = new Set<string>();
    for (const [key, value] of Object.entries(node)) {
      if (!key.startsWith('.') && !key.startsWith('$') && isPlainObject(value)) {
        literalChildren.add(key);
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (!key.startsWith('.') && isPlainObject(value)) {
        let childExclusions = exclusions;
        if (key.startsWith('$') && literalChildren.size > 0) {
          const next = new Map(exclusions);
          next.set(path.length, literalChildren);
          childExclusions = next;
        }
        walk(value, [...path, key], childExclusions);
      }
    }
  };

  walk(root, [], new Map());
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

function violatesRtdbWildcardExclusions(
  entry: RuleSurfaceEntry,
  pattern: ResourcePattern,
): boolean {
  const exclusions = RTDB_WILDCARD_EXCLUSIONS.get(entry);
  if (!exclusions || pattern.service !== 'rtdb') return false;
  for (const [segIndex, excludedLiterals] of exclusions) {
    const seg = pattern.segments[segIndex];
    if (!seg) break;
    if (seg.kind === 'lit' && excludedLiterals.has(seg.text)) {
      return true;
    }
    if (seg.kind === 'rest') break;
  }
  return false;
}

function rtdbValidateCoversTarget(
  validateEntry: RuleSurfaceEntry,
  target: ResourcePattern,
): boolean {
  if (validateEntry.pattern.service !== 'rtdb' || target.service !== 'rtdb') return false;
  if (validateEntry.pattern.resourceId !== target.resourceId) return false;
  const valSegs = validateEntry.pattern.segments;
  const targetSegs = target.segments;
  if (valSegs.length > targetSegs.length) return false;
  const exclusions = RTDB_WILDCARD_EXCLUSIONS.get(validateEntry);
  for (let i = 0; i < valSegs.length; i += 1) {
    const vSeg = valSegs[i]!;
    const tSeg = targetSegs[i]!;
    if (vSeg.kind === 'lit') {
      if (tSeg.kind !== 'lit' || tSeg.text !== vSeg.text) return false;
      continue;
    }
    if (vSeg.kind === 'var') {
      const excluded = exclusions?.get(i);
      if (tSeg.kind === 'lit') {
        if (excluded?.has(tSeg.text)) return false;
        continue;
      }
      if (tSeg.kind === 'var') {
        if (excluded && excluded.size > 0) return false;
        continue;
      }
      return false;
    }
    return false;
  }
  return true;
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
      ),
    );
  }

  const explicitStorageBuckets = new Set<string>();
  const rtdbAlwaysDenyValidates: RuleSurfaceEntry[] = [];
  for (const entry of entries) {
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
