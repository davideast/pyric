/**
 * Storage rules -- shared syntax, storage-specific evaluation.
 *
 * Firebase Security Rules is ONE language across Firestore and Storage.
 * Parsing goes through the shared Ohm grammar
 * (`../grammar/FirestoreRules.ohm`), whose syntax layer is
 * service-agnostic; `rules-ast-converter.ts` maps the shared AST into
 * the evaluator's internal shapes.
 */

import { parseToASTOrError } from '../grammar/FirestoreParser.js';
import { parseErrorWording } from '../grammar/parse-error-wording.js';
import { compileLimitViolations, describeCompileLimitViolations } from '../grammar/compile-limits.js';
import { DUPLICATE_SERVICE_REASON, duplicateServiceRejection } from '../grammar/source-compile-limits.js';
import { storageServiceBlock, topLevelMatches, withSingleService } from '../grammar/service-blocks.js';
import {
  readAuthoredSourceMap,
  resolveAuthoredLoc,
} from '../modules/resolver-browser.js';
import { RulesFloat } from '../simulator/wrappers/float.js';
import { Bytes } from '../simulator/wrappers/bytes.js';
import type { RulesResourceLimit } from '../test/spec.js';
import type { FirestoreRules as SharedRules } from '../grammar/FirestoreAST.js';
import { convertFunction, convertMatch } from './rules-ast-converter.js';
import { validateMatchRegexes } from './rules-regex-validation.js';

// ===============================================================
// Public types
// ===============================================================

/** Coarse permission umbrellas. `read` covers get + list; `write` covers create + update + delete. */
export type StorageMethod = 'read' | 'write';

/** Granular operation verbs. */
export type StorageVerb = 'get' | 'list' | 'create' | 'update' | 'delete';

/** What a caller records as the request's operation. */
export type StorageRequestMethod = StorageMethod | StorageVerb;

/** A verb token that may appear in an `allow` clause. */
export type StorageGrantVerb = StorageMethod | StorageVerb;

/**
 * Expand a coarse umbrella verb into its granular sub-verbs; a granular
 * verb expands to itself.
 */
export function expandVerb(verb: StorageGrantVerb | StorageRequestMethod): StorageVerb[] {
  switch (verb) {
    case 'read':
      return ['get', 'list'];
    case 'write':
      return ['create', 'update', 'delete'];
    default:
      return [verb];
  }
}

/** Identity passed in with the request. `null` is anonymous. */
export interface StorageAuth {
  uid: string;
  token?: Record<string, unknown>;
  tenant?: string;
}

/** Inbound request bindings the rules see. */
export interface StorageRequest {
  auth: StorageAuth | null;
  method: StorageRequestMethod;
  /** Path of the object the request targets. */
  path: string;
  resource?: StorageRequestResource;
}

/** The `request.resource` binding: the object a write would store. */
export interface StorageRequestResource {
  size: number;
  contentType?: string;
  metadata?: Record<string, string> | null;
  name?: string;
  bucket?: string;
  contentDisposition?: string | null;
  contentEncoding?: string | null;
  contentLanguage?: string | null;
  cacheControl?: string | null;
  generation?: number | null;
  metageneration?: number | null;
  md5Hash?: string;
  crc32c?: string;
  etag?: string | null;
}

/** Existing-object bindings (for `resource.*`). `null` when no object exists yet (creates). */
export interface StorageResource {
  size: number;
  contentType?: string;
  metadata?: Record<string, string>;
  name?: string;
  bucket?: string;
  timeCreated?: string;
  updated?: string;
  generation?: number;
  metageneration?: number;
  md5Hash?: string;
  crc32c?: string;
  etag?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  cacheControl?: string;
}

export interface EvaluationInput {
  request: StorageRequest;
  resource: StorageResource | null;
}

export interface EvaluationResult {
  allowed: boolean;
  reasons: string[];
  evaluatedExpressions: number;
  resourceLimit?: RulesResourceLimit;
}

/**
 * Injected capability that lets a Storage rule read Firestore documents
 * (`firestore.get(path)` / `firestore.exists(path)`).
 */
export interface FirestoreLookup {
  get(path: string): Record<string, unknown> | null;
  exists(path: string): boolean;
  readonly publicCases?: boolean;
}

/** Opaque parsed-rules handle returned by `parseStorageRules`. */
export interface StorageRules {
  readonly _root: MatchBlock;
  readonly _version: string;
}

// ===============================================================
// AST
// ===============================================================

export interface MatchBlock {
  segments: PathSegment[];
  children: MatchBlock[];
  allows: AllowRule[];
  functions: FunctionDef[];
  visibleFuncs?: FunctionMap;
}

export interface FunctionDef {
  name: string;
  params: string[];
  exported?: boolean;
  lets: { name: string; value: Expr }[];
  body: Expr;
  unresolvedImport?: string;
  declScope?: FunctionMap;
  scopeKind?: 'global' | 'service' | 'match';
  declCaptures?: ReadonlySet<string>;
}

export type FunctionMap = Map<string, FunctionDef>;

export type PathSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'wildcard'; name: string };

export interface AllowRule {
  verbs: StorageGrantVerb[];
  condition: Expr | null;
  line?: number;
}

export type BinaryOp =
  | '&&' | '||' | '==' | '!=' | '<' | '>' | '<=' | '>='
  | '+' | '-' | '*' | '/' | '%';

export type Expr =
  | { kind: 'literal'; value: bigint | RulesFloat | string | boolean | null | Bytes }
  | { kind: 'ident'; name: string }
  | { kind: 'member'; target: Expr; name: string }
  | { kind: 'index'; target: Expr; index: Expr }
  | { kind: 'slice'; target: Expr; start: Expr; end: Expr }
  | { kind: 'unary'; op: '!' | '-'; arg: Expr }
  | { kind: 'ternary'; cond: Expr; then: Expr; else: Expr }
  | { kind: 'in'; element: Expr; collection: Expr }
  | { kind: 'is'; value: Expr; typeName: string }
  | { kind: 'list'; elements: Expr[] }
  | { kind: 'map'; entries: { key: Expr; value: Expr }[] }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'methodcall'; target: Expr; method: string; args: Expr[] }
  | { kind: 'path'; segments: PathArgSegment[] };

export type PathArgSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'interp'; expr: Expr };

// ===============================================================
// Public entry points
// ===============================================================

/** Options for `parseStorageRules`. */
export interface ParseStorageRulesOptions {
  /** Skip literal regex validation when inspecting a broken source (for example, in non-deploy tooling). */
  allowInvalidRegex?: boolean;
}

/**
 * Parse a Storage rules source into an opaque handle. Throws
 * `SyntaxError` on malformed input.
 */
export function parseStorageRules(
  source: string,
  options?: ParseStorageRulesOptions,
): StorageRules {
  const parsed = parseToASTOrError(source);
  if (!parsed.ok) {
    throw new SyntaxError(
      `Storage rules parse error at line ${parsed.error.line}, column ${parsed.error.column}: ${parseErrorWording(parsed.error, source)}.`,
    );
  }
  const duplicate = duplicateServiceRejection(parsed.ast);
  if (duplicate !== null) {
    throw new SyntaxError(`Storage rules do not compile: ${DUPLICATE_SERVICE_REASON}`);
  }
  const storageService = storageServiceBlock(parsed.ast);
  const sourceMap = readAuthoredSourceMap(source);
  let astForLimits: SharedRules = parsed.ast;
  if (storageService !== undefined) {
    astForLimits = withSingleService(parsed.ast, storageService);
  }
  const rawViolations = compileLimitViolations(astForLimits, { allowUnresolvedImports: true }).filter(
    (v) => v.code !== 'INVALID_REGEX_PATTERN',
  );
  if (rawViolations.length > 0) {
    let violations = rawViolations;
    if (sourceMap.size > 0) {
      violations = rawViolations.map((v) => {
        if (v.line === undefined) return v;
        const mappedLoc = resolveAuthoredLoc(sourceMap, v.line);
        if (mappedLoc === undefined) return v;
        return { ...v, line: mappedLoc.line };
      });
    }
    throw new SyntaxError(`Storage rules do not compile: ${describeCompileLimitViolations(violations)}`);
  }
  const importStubs: FunctionDef[] = (parsed.ast.imports ?? []).flatMap((imp) =>
    imp.functions.map((name): FunctionDef => ({
      name,
      params: [],
      lets: [],
      body: { kind: 'literal', value: null },
      unresolvedImport: imp.module,
      scopeKind: 'global',
      declCaptures: new Set(),
    })),
  );
  const globalFuncs: FunctionDef[] = (parsed.ast.functions ?? []).map((fn) => {
    const converted = convertFunction(fn, sourceMap);
    converted.scopeKind = 'global';
    converted.declCaptures = new Set();
    return converted;
  });
  const globalScope: FunctionMap = new Map();
  for (const fn of importStubs) globalScope.set(fn.name, fn);
  for (const fn of globalFuncs) globalScope.set(fn.name, fn);
  for (const fn of globalScope.values()) fn.declScope = globalScope;

  const serviceFuncs: FunctionDef[] = (storageService?.functions ?? []).map((fn) => {
    const converted = convertFunction(fn, sourceMap);
    converted.scopeKind = 'service';
    converted.declCaptures = new Set();
    return converted;
  });
  const serviceScope: FunctionMap = new Map(globalScope);
  for (const fn of serviceFuncs) serviceScope.set(fn.name, fn);
  for (const fn of serviceFuncs) fn.declScope = serviceScope;

  const root: MatchBlock = {
    segments: [],
    children: topLevelMatches(storageService).map((block) => convertMatch(block, sourceMap)),
    allows: [],
    functions: [...importStubs, ...globalFuncs, ...serviceFuncs],
    visibleFuncs: serviceScope,
  };
  for (const child of root.children) {
    resolveFunctions(child, serviceScope, new Set());
  }
  if (!options?.allowInvalidRegex) {
    validateMatchRegexes(root);
  }
  return { _root: root, _version: parsed.ast.version };
}

function resolveFunctions(
  block: MatchBlock,
  parent: FunctionMap,
  parentCaptures: ReadonlySet<string>,
): void {
  const captures = new Set(parentCaptures);
  for (const seg of block.segments) {
    if (seg.kind === 'param' || seg.kind === 'wildcard') {
      captures.add(seg.name);
    }
  }
  const map: FunctionMap = new Map(parent);
  for (const fn of block.functions) map.set(fn.name, fn);
  block.visibleFuncs = map;
  for (const fn of block.functions) {
    fn.declScope = map;
    fn.scopeKind = 'match';
    fn.declCaptures = captures;
  }
  for (const child of block.children) resolveFunctions(child, map, captures);
}
