/**
 * The local Storage rules' verdict on an observed Cloud Storage call.
 *
 * The host evaluates the call against the rules deployed for its bucket,
 * with `request.resource` built from the metadata an upload or metadata
 * update sent and `resource` from the metadata a `getMetadata` returned. The
 * evaluator reports which of those it read, so a verdict that rested on one
 * the call did not carry is `unevaluated` instead of a guess. Object bytes
 * never reach the host.
 */
import {
  bindRulesBucket,
  compiledStorageRulesForBucket,
  DEFAULT_BUCKET,
  emptyStorageObservation,
  evaluateStorageRules,
  requestResourceFor,
  resourceFromStored,
  rulesBucketName,
  type StorageEvaluationObservation,
} from 'pyric/storage/internal';
import { UNREAD_BUCKET, type ObservedMethod } from 'pyric/sandbox/internal';
import type { ObservedCall } from 'pyric/sandbox';
import type { HostCtx } from '../host-context.js';
import {
  authOf,
  defineOwnField,
  definedOnly,
  givenBy,
  isPlainRecord,
  unionOf,
  verdictOf,
  type Gap,
  type Given,
  type LocalVerdict,
  type StorageLocal,
} from './observe-local-evaluation.js';

type StorageMethod = Exclude<ObservedMethod, 'set'>;
type ObjectFields = Record<string, unknown>;
type CompiledRules = NonNullable<ReturnType<typeof compiledStorageRulesForBucket>>;
type StorageMatchBlock = CompiledRules['_root'];
type StorageFunctionDef = StorageMatchBlock['functions'][number];
type StorageFunctionMap = NonNullable<StorageMatchBlock['visibleFuncs']>;
type StorageExpr = StorageFunctionDef['body'];
type StoragePathSegment = StorageMatchBlock['segments'][number];
type StorageGrantVerb = StorageMatchBlock['allows'][number]['verbs'][number];

const UNCAPTURED_STORED_HASH_FIELDS = ['md5Hash', 'crc32c', 'etag'] as const;
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

/** The buckets the app's default rules govern: its configured bucket and the project's two default names. */
function storageDefaultBuckets(ctx: HostCtx): string[] {
  const buckets: string[] = [];
  const configuredBucket = stringField(ctx.appOptions ?? {}, 'storageBucket');
  if (configuredBucket) buckets.push(configuredBucket);
  let projectId = stringField(ctx.appOptions ?? {}, 'projectId');
  if (projectId === undefined) projectId = ctx.rtdbProjectId;
  if (projectId) buckets.push(`${projectId}.appspot.com`, `${projectId}.firebasestorage.app`);
  return buckets;
}

/** The bucket a call names, or `undefined` when the page could not read it from the reference. */
function namedBucket(call: ObservedCall): string | undefined {
  if (call.bucket === UNREAD_BUCKET) return undefined;
  return call.bucket;
}

/** The object path a call names, without a leading slash. */
function objectPathOf(call: ObservedCall): string {
  const path = call.path;
  if (path === undefined) return '';
  if (path.startsWith('/')) return path.slice(1);
  return path;
}

function stringField(fields: ObjectFields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' ? value : undefined;
}

function customMetadataOf(raw: unknown): Record<string, string> | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') {
      defineOwnField(out, k, v);
    }
  }
  return out;
}

/**
 * The size `request.resource` names: the written size, else the stored
 * object's (a metadata update leaves the bytes as they are), else zero.
 */
function requestedObjectSize(written: ObjectFields, stored: ObjectFields | undefined): number {
  const writtenSize = written.size;
  if (typeof writtenSize === 'number') return writtenSize;
  const storedSize = stored?.size;
  if (typeof storedSize === 'number') return storedSize;
  return 0;
}

/** Whether the method sends object metadata the rules see as `request.resource`. */
function writesObject(method: StorageMethod): boolean {
  return method === 'create' || method === 'update';
}

/** `request.resource` for an upload or a metadata update, or `null` for a call that sent no metadata. */
function requestResourceOf(call: ObservedCall, method: StorageMethod, bucket: string, fullPath: string) {
  const written = isPlainRecord(call.writeData) ? call.writeData : undefined;
  if (!writesObject(method) || written === undefined) return undefined;
  const stored = isPlainRecord(call.document) ? call.document : undefined;
  const object = {
    bucket,
    fullPath,
    size: requestedObjectSize(written, stored),
    contentType: stringField(written, 'contentType'),
    customMetadata: customMetadataOf(written.customMetadata),
    cacheControl: stringField(written, 'cacheControl'),
    contentDisposition: stringField(written, 'contentDisposition'),
    contentEncoding: stringField(written, 'contentEncoding'),
    contentLanguage: stringField(written, 'contentLanguage'),
    generation: stringField(stored ?? {}, 'generation'),
    metageneration: stringField(stored ?? {}, 'metageneration'),
  };
  let write: 'upload' | 'metadataUpdate' = 'metadataUpdate';
  if (method === 'create') write = 'upload';
  return requestResourceFor(object, write);
}

/** `resource` from the metadata a call returned, or `null` when it returned none. */
function storedResourceOf(call: ObservedCall, bucket: string, fullPath: string) {
  if (!isPlainRecord(call.document)) return null;
  const stored = call.document;
  let size = 0;
  if (typeof stored.size === 'number') size = stored.size;
  return resourceFromStored({
    bucket,
    fullPath,
    size,
    contentType: stringField(stored, 'contentType'),
    customMetadata: customMetadataOf(stored.customMetadata),
    cacheControl: stringField(stored, 'cacheControl'),
    contentDisposition: stringField(stored, 'contentDisposition'),
    contentEncoding: stringField(stored, 'contentEncoding'),
    contentLanguage: stringField(stored, 'contentLanguage'),
    md5Hash: stringField(stored, 'md5Hash'),
    crc32c: stringField(stored, 'crc32c'),
    etag: stringField(stored, 'etag'),
    timeCreated: stringField(stored, 'timeCreated'),
    updated: stringField(stored, 'updated'),
    generation: stringField(stored, 'generation'),
    metageneration: stringField(stored, 'metageneration'),
  });
}

function missingStoredHashFieldsOf(call: ObservedCall): Set<string> {
  const missing = new Set<string>();
  const stored = isPlainRecord(call.document) ? call.document : undefined;
  if (stored === undefined) return missing;
  for (const field of UNCAPTURED_STORED_HASH_FIELDS) {
    if (stringField(stored, field) === undefined) missing.add(field);
  }
  return missing;
}

function grantCoversVerb(verbs: readonly StorageGrantVerb[], method: StorageMethod): boolean {
  for (const verb of verbs) {
    if (verb === method) return true;
    if (verb === 'read' && (method === 'get' || method === 'list')) return true;
    if (verb === 'write' && (method === 'create' || method === 'update' || method === 'delete')) return true;
  }
  return false;
}

function formatStorageSegments(segments: readonly StoragePathSegment[]): string {
  return (
    '/' +
    segments
      .map((s) => {
        if (s.kind === 'literal') return s.value;
        if (s.kind === 'param') return `{${s.name}}`;
        return `{${s.name}=**}`;
      })
      .join('/')
  );
}

function matchStorageSegments(
  segments: readonly StoragePathSegment[],
  remaining: readonly string[],
  rulesVersion: string,
): string[] | null {
  let index = 0;
  const minimum = rulesVersion === '2' || rulesVersion === '2+modules' ? 0 : 1;
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]!;
    if (seg.kind === 'wildcard') {
      const trailing = segments.length - 1 - s;
      const length = remaining.length - index - trailing;
      if (length < minimum) return null;
      index += length;
      continue;
    }
    if (index >= remaining.length) return null;
    if (seg.kind === 'literal') {
      if (remaining[index] !== seg.value) return null;
    }
    index += 1;
  }
  return remaining.slice(index);
}

function isResourceBindingExpr(
  expr: StorageExpr,
  resourceVars: ReadonlySet<string>,
  shadowedVars: ReadonlySet<string>,
): boolean {
  if (expr.kind !== 'ident') return false;
  if (resourceVars.has(expr.name)) return true;
  return expr.name === 'resource' && !shadowedVars.has('resource');
}

function exprMayReadMissingStoredProps(
  expr: StorageExpr,
  missingProps: ReadonlySet<string>,
  resourceVars: ReadonlySet<string>,
  shadowedVars: ReadonlySet<string>,
  funcs: StorageFunctionMap,
  activeFns: ReadonlySet<StorageFunctionDef>,
): boolean {
  const isRes = (node: StorageExpr): boolean => isResourceBindingExpr(node, resourceVars, shadowedVars);
  if (
    expr.kind === 'binary' &&
    (expr.op === '==' || expr.op === '!=') &&
    ((isRes(expr.left) && expr.right.kind === 'literal' && expr.right.value === null) ||
      (isRes(expr.right) && expr.left.kind === 'literal' && expr.left.value === null))
  ) {
    return false;
  }
  const recurse = (node: StorageExpr): boolean =>
    exprMayReadMissingStoredProps(node, missingProps, resourceVars, shadowedVars, funcs, activeFns);

  switch (expr.kind) {
    case 'literal':
      return false;
    case 'ident':
      return isRes(expr);
    case 'member':
      if (isRes(expr.target)) return missingProps.has(expr.name);
      return recurse(expr.target);
    case 'index':
      if (isRes(expr.target)) {
        if (recurse(expr.index)) return true;
        if (expr.index.kind === 'literal' && typeof expr.index.value === 'string') {
          return missingProps.has(expr.index.value);
        }
        return true;
      }
      return recurse(expr.target) || recurse(expr.index);
    case 'in':
      if (isRes(expr.collection)) {
        if (recurse(expr.element)) return true;
        if (expr.element.kind === 'literal' && typeof expr.element.value === 'string') {
          return missingProps.has(expr.element.value);
        }
        return true;
      }
      return recurse(expr.element) || recurse(expr.collection);
    case 'methodcall':
      if (isRes(expr.target)) {
        if (expr.args.some(recurse)) return true;
        if (expr.method === 'get') {
          const keyArg = expr.args[0];
          if (keyArg?.kind === 'literal' && typeof keyArg.value === 'string') {
            return missingProps.has(keyArg.value);
          }
          if (
            keyArg?.kind === 'list' &&
            keyArg.elements[0]?.kind === 'literal' &&
            typeof keyArg.elements[0].value === 'string'
          ) {
            return missingProps.has(keyArg.elements[0].value);
          }
          return true;
        }
        return true;
      }
      return recurse(expr.target) || expr.args.some(recurse);
    case 'call': {
      for (const arg of expr.args) {
        if (!isRes(arg) && recurse(arg)) return true;
      }
      const fn = funcs.get(expr.name);
      if (fn === undefined || activeFns.has(fn)) {
        return expr.args.some(isRes);
      }
      const nextResourceVars = new Set<string>();
      const nextShadowed = new Set<string>(fn.declCaptures ?? []);
      if (fn.scopeKind === 'global') nextShadowed.add('resource');
      for (let i = 0; i < fn.params.length; i++) {
        const paramName = fn.params[i]!;
        const arg = expr.args[i];
        if (arg !== undefined && isRes(arg)) {
          nextResourceVars.add(paramName);
          nextShadowed.delete(paramName);
        } else {
          nextShadowed.add(paramName);
        }
      }
      const fnScope = fn.declScope ?? funcs;
      const nextActive = new Set(activeFns);
      nextActive.add(fn);
      for (const binding of fn.lets) {
        if (isResourceBindingExpr(binding.value, nextResourceVars, nextShadowed)) {
          nextResourceVars.add(binding.name);
          nextShadowed.delete(binding.name);
        } else {
          if (
            exprMayReadMissingStoredProps(
              binding.value,
              missingProps,
              nextResourceVars,
              nextShadowed,
              fnScope,
              nextActive,
            )
          ) {
            return true;
          }
          nextResourceVars.delete(binding.name);
          nextShadowed.add(binding.name);
        }
      }
      return exprMayReadMissingStoredProps(
        fn.body,
        missingProps,
        nextResourceVars,
        nextShadowed,
        fnScope,
        nextActive,
      );
    }
    case 'slice':
      return recurse(expr.target) || recurse(expr.start) || recurse(expr.end);
    case 'unary':
      return recurse(expr.arg);
    case 'ternary':
      return recurse(expr.cond) || recurse(expr.then) || recurse(expr.else);
    case 'is':
      return recurse(expr.value);
    case 'list':
      return expr.elements.some(recurse);
    case 'map':
      return expr.entries.some((entry) => recurse(entry.key) || recurse(entry.value));
    case 'binary':
      return recurse(expr.left) || recurse(expr.right);
    case 'path':
      return expr.segments.some((seg) => seg.kind === 'interp' && recurse(seg.expr));
  }
}

function evaluationMayReadMissingStoredProps(
  rules: CompiledRules,
  requestPath: string,
  method: StorageMethod,
  allowed: boolean,
  matchedRule: StorageEvaluationObservation['matchedRule'],
  missingProps: ReadonlySet<string>,
): boolean {
  if (missingProps.size === 0) return false;
  const pathSegments = requestPath.split('/').filter((s) => s.length > 0);
  const minimum = rules._version === '2' || rules._version === '2+modules' ? 0 : 1;
  let stoppedAtGrant = false;
  let foundRead = false;

  const visit = (
    block: StorageMatchBlock,
    remaining: readonly string[],
    inheritedCaptures: ReadonlySet<string>,
  ): void => {
    if (stoppedAtGrant || foundRead) return;
    const left = matchStorageSegments(block.segments, remaining, rules._version);
    if (left === null) return;
    const captures = new Set(inheritedCaptures);
    for (const seg of block.segments) {
      if (seg.kind !== 'literal') captures.add(seg.name);
    }
    if (left.length === 0) {
      const blockPath = `match ${formatStorageSegments(block.segments)}`;
      const funcs: StorageFunctionMap = block.visibleFuncs ?? new Map();
      for (const allow of block.allows) {
        if (!grantCoversVerb(allow.verbs, method)) continue;
        if (
          allow.condition !== null &&
          exprMayReadMissingStoredProps(
            allow.condition,
            missingProps,
            EMPTY_STRING_SET,
            captures,
            funcs,
            new Set(),
          )
        ) {
          foundRead = true;
          return;
        }
        if (
          allowed &&
          matchedRule !== undefined &&
          matchedRule.path === blockPath &&
          matchedRule.line === allow.line
        ) {
          stoppedAtGrant = true;
          return;
        }
      }
    }
    const lastSeg = block.segments[block.segments.length - 1];
    if (block.children.length > 0 && lastSeg !== undefined && lastSeg.kind === 'wildcard') {
      const prefixLeft = matchStorageSegments(block.segments.slice(0, -1), remaining, rules._version);
      if (prefixLeft !== null) {
        for (let splitLen = prefixLeft.length; splitLen >= minimum; splitLen--) {
          const childLeft = prefixLeft.slice(splitLen);
          for (const child of block.children) {
            visit(child, childLeft, captures);
            if (stoppedAtGrant || foundRead) return;
          }
        }
        return;
      }
    }
    for (const child of block.children) {
      visit(child, left, captures);
      if (stoppedAtGrant || foundRead) return;
    }
  };

  visit(rules._root, pathSegments, EMPTY_STRING_SET);
  return foundRead;
}

/** The data the evaluation read that the call did not carry. */
function storageGaps(
  observation: StorageEvaluationObservation,
  method: StorageMethod,
  given: Given,
  readMissingStoredHash: boolean,
): Gap[] {
  const gaps: Gap[] = [];
  if ((observation.readResource && !given.document) || readMissingStoredHash) gaps.push('stored-document');
  if (observation.readFirestore) gaps.push('stored-document');
  if (observation.readRequestResource) {
    if (writesObject(method) && !given.writeData) gaps.push('write-data');
    // A metadata update's incoming object keeps the stored fields it does not name.
    if (method === 'update' && !given.document) gaps.push('stored-document');
  }
  if (observation.readAuthToken && !given.claims) gaps.push('claim-values');
  if (observation.readAuthTokenEmail && !given.emailKnown) gaps.push('claim-values');
  return unionOf(gaps, []);
}

/** The Storage record a verdict carries: the matched rule and the evaluator's reasons. */
function storageRecordOf(observation: StorageEvaluationObservation, reasons: readonly string[]): StorageLocal | undefined {
  const record: StorageLocal = {};
  const matched = observation.matchedRule;
  if (matched !== undefined) record.matchedPath = matched.path;
  if (matched?.line !== undefined) record.matchedLine = matched.line;
  if (reasons.length > 0) record.reasons = [...reasons];
  if (Object.keys(record).length === 0) return undefined;
  return record;
}

/** The app's Storage rules' verdict on an observed Storage call, or `undefined` when no rules govern its bucket. */
export function storageVerdict(ctx: HostCtx, call: ObservedCall, method: ObservedMethod): LocalVerdict | undefined {
  if (method === 'set') return undefined;
  const bucket = namedBucket(call);
  const rules = compiledStorageRulesForBucket(ctx.sandbox, bucket, storageDefaultBuckets(ctx));
  if (rules === null) return undefined;
  const effectiveBucket = rulesBucketName(DEFAULT_BUCKET, bucket);
  const objectPath = objectPathOf(call);
  const fullPath = `b/${effectiveBucket}/o/${objectPath}`;
  const request = {
    auth: authOf(call),
    method,
    path: objectPath,
    resource: requestResourceOf(call, method, effectiveBucket, fullPath),
  };
  const input = bindRulesBucket(
    { request, resource: storedResourceOf(call, effectiveBucket, fullPath) },
    effectiveBucket,
    effectiveBucket,
  );
  const observation = emptyStorageObservation();
  const evaluated = evaluateStorageRules(rules, input, new Date(call.at), undefined, observation);
  const given = givenBy(call, method);
  const readMissingStoredHash =
    given.document &&
    observation.readResource &&
    evaluationMayReadMissingStoredProps(
      rules,
      input.request.path,
      method,
      evaluated.allowed,
      observation.matchedRule,
      missingStoredHashFieldsOf(call),
    );
  const matched = observation.matchedRule;
  let rule: LocalVerdict['rule'];
  if (matched !== undefined) rule = definedOnly({ path: matched.path, line: matched.line });
  return verdictOf(call, {
    allowed: evaluated.allowed,
    rule,
    needs: storageGaps(observation, method, given, readMissingStoredHash),
    storage: storageRecordOf(observation, evaluated.reasons),
  });
}
