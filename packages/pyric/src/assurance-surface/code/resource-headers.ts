/**
 * Service handle `resourceId` evaluation and inline resource header extraction
 * for multi-database Firestore, multi-instance Realtime Database, and
 * multi-bucket Cloud Storage references.
 */
import type ts from 'typescript';
import {
  parseResourcePattern,
  type AssuranceService,
  type PatternSegment,
} from '../../sandbox/internal/resource-pattern.js';
import {
  DEFAULT_RESOURCE_ID,
  extractServiceHeader,
  normalizeExplicitResourceId,
} from '../../sandbox/internal/resource-pattern-header.js';
import type { Evaluator } from './evaluator.js';
import type { HandleFactorySpec } from './service-models/types.js';
import {
  alternatives,
  concatParts,
  literalText,
  union,
  type AVal,
  type StrPart,
} from './values.js';

export interface HeaderAlternative {
  readonly resourceId: string;
  readonly value: AVal;
  readonly note?: string;
  readonly fromCallers?: boolean;
}

const HOLE_TOKEN_PREFIX = '__PYRIC_HOLE_';
const HOLE_TOKEN_SUFFIX = '__';
const HOLE_TOKEN_SCAN_SOURCE = '__PYRIC_HOLE_(\\d+)__';
const ANY_HOLE_TOKEN_RE = /__pyric_hole_\d+__/i;
const HEADER_PREFIX_RE = /^(?:(?:https?|wss?|gs):\/\/|\/?(?:databases|b)\/)/i;
const STORAGE_URL_SCHEME_RE = /^(?:gs|https?):\/\//i;
const HTTP_URL_SCHEME_RE = /^https?:\/\//i;

function stripIgnoredUrlSuffix(service: AssuranceService, encoded: string): string {
  let clean = encoded;
  const hashIndex = clean.indexOf('#');
  if (hashIndex >= 0) {
    clean = clean.slice(0, hashIndex);
  }
  if (service === 'storage' && HTTP_URL_SCHEME_RE.test(clean.trimStart())) {
    const queryIndex = clean.indexOf('?');
    if (queryIndex >= 0) {
      clean = clean.slice(0, queryIndex);
    }
  }
  return clean;
}

function holeIndicesIn(text: string): Set<number> {
  const indices = new Set<number>();
  const scan = new RegExp(HOLE_TOKEN_SCAN_SOURCE, 'g');
  for (let m = scan.exec(text); m !== null; m = scan.exec(text)) {
    indices.add(Number(m[1]));
  }
  return indices;
}

/** True when `v` is or contains an unforced caller parameter symbol (`k: 'sym'`). */
export function containsCallerSymbol(v: AVal): boolean {
  if (v.k === 'sym') return true;
  if (v.k === 'union') return v.alts.some(containsCallerSymbol);
  return false;
}

function buildDbHandle(
  service: AssuranceService,
  resourceId: string,
  note: string | undefined,
  fromCallers: boolean,
  admin: boolean,
): AVal {
  const out: Extract<AVal, { k: 'db' }> = {
    k: 'db',
    service,
    resourceId,
  };
  if (note !== undefined) out.notes = [note];
  if (fromCallers) out.fromCallers = true;
  if (admin) out.admin = true;
  return out;
}

function dbHandleFromExplicitAlternative(
  service: AssuranceService,
  fnName: string,
  alt: AVal,
  fromCallers: boolean,
  admin: boolean,
): AVal {
  if (alt.k === 'undefined') {
    return buildDbHandle(service, DEFAULT_RESOURCE_ID, undefined, fromCallers, admin);
  }
  const text = literalText(alt);
  if (text !== null) {
    const normalized = normalizeExplicitResourceId(service, text);
    if (normalized !== undefined) {
      return buildDbHandle(service, normalized, undefined, fromCallers, admin);
    }
    return buildDbHandle(
      service,
      DEFAULT_RESOURCE_ID,
      `resource argument of ${fnName}() was not valid`,
      fromCallers,
      admin,
    );
  }
  if (alt.k === 'str') {
    return buildDbHandle(
      service,
      DEFAULT_RESOURCE_ID,
      `resource argument of ${fnName}() was not literal`,
      fromCallers,
      admin,
    );
  }
  if (alt.k === 'unknown') {
    return buildDbHandle(
      service,
      DEFAULT_RESOURCE_ID,
      `resource argument of ${fnName}() was not traced (${alt.reason})`,
      fromCallers,
      admin,
    );
  }
  return buildDbHandle(
    service,
    DEFAULT_RESOURCE_ID,
    `resource argument of ${fnName}() was not traced`,
    fromCallers,
    admin,
  );
}

/** Evaluate a service handle factory (`getFirestore`, `getDatabase`, `getStorage`, etc.). */
export function evalHandleFactory(
  ev: Evaluator,
  service: AssuranceService,
  fnName: string,
  spec: HandleFactorySpec,
  call: ts.CallExpression,
  arg: (i: number) => AVal,
  admin = false,
): AVal {
  if (spec.resourceArgIndex !== undefined && call.arguments.length > spec.resourceArgIndex) {
    const rawArg = arg(spec.resourceArgIndex);
    const fromCallers = containsCallerSymbol(rawArg);
    const alts = alternatives(ev.force(rawArg));
    if (alts.length === 0) {
      return buildDbHandle(
        service,
        DEFAULT_RESOURCE_ID,
        `resource argument of ${fnName}() was not traced`,
        fromCallers,
        admin,
      );
    }
    const handles = alts.map((alt) =>
      dbHandleFromExplicitAlternative(service, fnName, alt, fromCallers, admin),
    );
    return union(handles);
  }

  if (call.arguments.length === 1 && spec.singleStringArgIsResource) {
    const rawArg = arg(0);
    const fromCallers = containsCallerSymbol(rawArg);
    const alts = alternatives(ev.force(rawArg));
    if (alts.length === 0) {
      return buildDbHandle(service, DEFAULT_RESOURCE_ID, undefined, fromCallers, admin);
    }
    const handles: AVal[] = [];
    for (const alt of alts) {
      if (alt.k === 'str') {
        handles.push(dbHandleFromExplicitAlternative(service, fnName, alt, fromCallers, admin));
      } else {
        handles.push(buildDbHandle(service, DEFAULT_RESOURCE_ID, undefined, false, admin));
      }
    }
    return union(handles);
  }

  return buildDbHandle(service, DEFAULT_RESOURCE_ID, undefined, false, admin);
}

function patternSegmentRawText(seg: PatternSegment): string {
  if (seg.kind === 'lit') return seg.text;
  if (seg.kind === 'rest') return `{${seg.name}=**}`;
  return `${seg.prefix ?? ''}{${seg.name}}${seg.suffix ?? ''}`;
}

function hasServiceHeader(parts: StrPart[], forceCheck: boolean): boolean {
  if (forceCheck) return true;
  const first = parts[0];
  return first?.kind === 'lit' && HEADER_PREFIX_RE.test(first.text.trimStart());
}

/** Extract an inline service header from a string value, guarding against dynamic header holes. */
export function extractStringHeader(
  service: AssuranceService,
  fnName: string,
  parts: StrPart[],
  fallbackResourceId: string,
  forceCheck: boolean,
): { resourceId: string; value: AVal; note?: string } {
  if (!hasServiceHeader(parts, forceCheck)) {
    return { resourceId: fallbackResourceId, value: { k: 'str', parts } };
  }
  const holes: StrPart[] = [];
  let encoded = '';
  for (const p of parts) {
    if (p.kind === 'lit') {
      encoded += p.text;
    } else {
      encoded += `${HOLE_TOKEN_PREFIX}${holes.length}${HOLE_TOKEN_SUFFIX}`;
      holes.push(p);
    }
  }
  const extracted = extractServiceHeader(service, encoded);
  const parsed = parseResourcePattern(service, encoded, fallbackResourceId);
  const joinedBody = parsed.segments.map(patternSegmentRawText).join('/');
  const rebuilt: StrPart[] = [];
  const usedHoles = new Set<number>();
  const scanRe = new RegExp(HOLE_TOKEN_SCAN_SOURCE, 'g');
  let last = 0;
  for (let m = scanRe.exec(joinedBody); m !== null; m = scanRe.exec(joinedBody)) {
    if (m.index > last) rebuilt.push({ kind: 'lit', text: joinedBody.slice(last, m.index) });
    const holeIdx = Number(m[1]);
    usedHoles.add(holeIdx);
    const holePart = holes[holeIdx];
    if (holePart) rebuilt.push(holePart);
    last = m.index + m[0].length;
  }
  if (last < joinedBody.length) rebuilt.push({ kind: 'lit', text: joinedBody.slice(last) });

  const significantHoles = holeIndicesIn(stripIgnoredUrlSuffix(service, encoded));
  const leakedHeaderHole = ANY_HOLE_TOKEN_RE.test(parsed.resourceId);
  const missingHeaderHole = [...significantHoles].some((idx) => !usedHoles.has(idx));
  const nonConcreteHeader =
    extracted.headerKind === 'wildcard' || extracted.headerKind === 'malformed';
  const trimmedEncoded = encoded.trimStart();
  const missingForcedScheme =
    forceCheck
    && (
      (holes.length > 0 && !HEADER_PREFIX_RE.test(trimmedEncoded))
      || (service === 'storage' && !STORAGE_URL_SCHEME_RE.test(trimmedEncoded))
    );

  if (leakedHeaderHole || missingHeaderHole || nonConcreteHeader || missingForcedScheme) {
    return {
      resourceId: fallbackResourceId,
      value: { k: 'str', parts: concatParts(rebuilt) },
      note: `resource header of ${fnName}() was not literal`,
    };
  }

  return {
    resourceId: parsed.resourceId,
    value: { k: 'str', parts: concatParts(rebuilt) },
  };
}

/** Split union/parameter path alternatives by resolved `resourceId` and header notes. */
export function splitHeaderAlternatives(
  service: AssuranceService,
  fnName: string,
  rawVal: AVal,
  fallbackResourceId: string,
  force: (v: AVal) => AVal,
  forceCheck: boolean,
): HeaderAlternative[] {
  const rawAlts = alternatives(rawVal);
  if (rawAlts.length === 0) return [{ resourceId: fallbackResourceId, value: rawVal }];
  const out: HeaderAlternative[] = [];
  const plainByResource = new Map<string, AVal[]>();
  const addPlain = (resourceId: string, val: AVal): void => {
    const list = plainByResource.get(resourceId) ?? [];
    list.push(val);
    plainByResource.set(resourceId, list);
  };
  for (const rawAlt of rawAlts) {
    if (rawAlt.k === 'sym') {
      const forcedSym = force(rawAlt);
      const symHasHeader = alternatives(forcedSym).some(
        (a) => a.k === 'str' && hasServiceHeader(a.parts, forceCheck),
      );
      if (symHasHeader) {
        const splitSubs = splitHeaderAlternatives(
          service,
          fnName,
          forcedSym,
          fallbackResourceId,
          force,
          forceCheck,
        );
        for (const sub of splitSubs) {
          out.push({ ...sub, fromCallers: true });
        }
      } else {
        addPlain(fallbackResourceId, rawAlt);
      }
      continue;
    }
    if (rawAlt.k === 'str' && hasServiceHeader(rawAlt.parts, forceCheck)) {
      const split = extractStringHeader(service, fnName, rawAlt.parts, fallbackResourceId, true);
      if (split.note !== undefined) {
        out.push({ resourceId: split.resourceId, value: split.value, note: split.note });
      } else {
        addPlain(split.resourceId, split.value);
      }
      continue;
    }
    addPlain(fallbackResourceId, rawAlt);
  }
  for (const [resourceId, vals] of plainByResource) {
    out.push({ resourceId, value: union(vals) });
  }
  return out;
}
