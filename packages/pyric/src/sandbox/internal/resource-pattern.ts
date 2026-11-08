/**
 * Cross-service resource pattern algebra for Firestore, Realtime Database, and
 * Cloud Storage paths and rule match blocks.
 */

import {
  BRACE_VAR_RE,
  DOLLAR_PAREN_VAR_RE,
  DOLLAR_VAR_RE,
  REST_SEGMENT_RE,
  extractServiceHeader,
  resolveConcreteResourceId,
  resolvePatternResourceId,
  type AssuranceService,
} from './resource-pattern-header.js';

export type { AssuranceService } from './resource-pattern-header.js';

export type PatternSegment =
  | { readonly kind: 'lit'; readonly text: string }
  | { readonly kind: 'var'; readonly name: string; readonly prefix?: string; readonly suffix?: string }
  | { readonly kind: 'rest'; readonly name: string };

export interface ResourcePattern {
  readonly service: AssuranceService;
  /** '(default)' | named databaseId | RTDB instance name | Storage bucket name */
  readonly resourceId: string;
  readonly segments: readonly PatternSegment[];
}

export interface CoversPatternOptions {
  readonly cascade?: boolean;
}

export interface OverlapsPatternOptions {
  readonly cascadeA?: boolean;
  readonly cascadeB?: boolean;
}

export interface UnifyPatternsOptions {
  readonly cascade?: boolean;
}

function splitNonEmptySegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function buildVarSegment(name: string, prefix: string, suffix: string): PatternSegment {
  if (prefix.length > 0 && suffix.length > 0) return { kind: 'var', name, prefix, suffix };
  if (prefix.length > 0) return { kind: 'var', name, prefix };
  if (suffix.length > 0) return { kind: 'var', name, suffix };
  return { kind: 'var', name };
}

function parsePatternSegment(rawSegment: string): PatternSegment {
  const restMatch = REST_SEGMENT_RE.exec(rawSegment);
  if (restMatch !== null) return { kind: 'rest', name: restMatch[1]! };
  const dollarMatch = DOLLAR_VAR_RE.exec(rawSegment);
  if (dollarMatch !== null) return { kind: 'var', name: dollarMatch[1]! };
  const dollarParenMatch = DOLLAR_PAREN_VAR_RE.exec(rawSegment);
  if (dollarParenMatch !== null) {
    return buildVarSegment(dollarParenMatch[2]!, dollarParenMatch[1]!, dollarParenMatch[3]!);
  }
  const braceMatch = BRACE_VAR_RE.exec(rawSegment);
  if (braceMatch !== null) return buildVarSegment(braceMatch[2]!, braceMatch[1]!, braceMatch[3]!);
  return { kind: 'lit', text: rawSegment };
}

export function parseResourcePattern(
  service: AssuranceService,
  rawPath: string,
  resourceId?: string,
): ResourcePattern {
  const extracted = extractServiceHeader(service, rawPath);
  const resolvedId = resolvePatternResourceId(service, resourceId, extracted);
  const segments = splitNonEmptySegments(extracted.bodyPath).map(parsePatternSegment);
  return { service, resourceId: resolvedId, segments };
}

function renderSegment(service: AssuranceService, segment: PatternSegment): string {
  if (segment.kind === 'lit') return segment.text;
  if (segment.kind === 'rest') return `{${segment.name}=**}`;
  const prefix = segment.prefix ?? '';
  const suffix = segment.suffix ?? '';
  if (service === 'rtdb' && prefix.length === 0 && suffix.length === 0) {
    return `$${segment.name}`;
  }
  return `${prefix}{${segment.name}}${suffix}`;
}

export function renderResourcePattern(pattern: ResourcePattern): string {
  return pattern.segments.map((segment) => renderSegment(pattern.service, segment)).join('/');
}

function escapeShapeLiteral(text: string): string {
  return text.replace(/%/g, '%25').replace(/\*/g, '%2A');
}

function shapeKeySegment(segment: PatternSegment): string {
  if (segment.kind === 'lit') return escapeShapeLiteral(segment.text);
  if (segment.kind === 'rest') return '**';
  return `${escapeShapeLiteral(segment.prefix ?? '')}*${escapeShapeLiteral(segment.suffix ?? '')}`;
}

export function resourceShapeKey(pattern: ResourcePattern): string {
  const body = pattern.segments.map(shapeKeySegment).join('/');
  return `${pattern.service}:${pattern.resourceId}:${body}`;
}

function parseConcreteBodySegments(bodyPath: string): PatternSegment[] | null {
  const trimmed = bodyPath.trim();
  if (trimmed.includes('//')) return null;
  const stripped = trimmed.replace(/^\/|\/$/g, '');
  if (stripped.length === 0) return [];
  const parts = stripped.split('/');
  if (parts.some((part) => part.length === 0)) return null;
  return parts.map((text): PatternSegment => ({ kind: 'lit', text }));
}

function sameResourceScope(a: ResourcePattern, b: ResourcePattern): boolean {
  return a.service === b.service && a.resourceId === b.resourceId;
}

function isHabitableSegment(segment: PatternSegment): boolean {
  if (segment.kind === 'lit') return segment.text.length > 0;
  return true;
}

function canInstantiateFrom(segments: readonly PatternSegment[], index: number): boolean {
  for (let i = index; i < segments.length; i += 1) {
    if (!isHabitableSegment(segments[i]!)) return false;
  }
  return true;
}

function matchesVarAffixes(
  varSegment: Extract<PatternSegment, { readonly kind: 'var' }>,
  text: string,
): boolean {
  const prefix = varSegment.prefix ?? '';
  const suffix = varSegment.suffix ?? '';
  if (prefix.length === 0 && suffix.length === 0) return text.length > 0;
  return (
    text.length >= prefix.length + suffix.length
    && text.startsWith(prefix)
    && text.endsWith(suffix)
  );
}

function singleSegmentCovers(ruleSegment: PatternSegment, targetSegment: PatternSegment): boolean {
  if (targetSegment.kind === 'rest') return false;
  if (ruleSegment.kind === 'lit') {
    return targetSegment.kind === 'lit' && targetSegment.text === ruleSegment.text;
  }
  if (ruleSegment.kind === 'var') {
    if (targetSegment.kind === 'lit') return matchesVarAffixes(ruleSegment, targetSegment.text);
    const rPrefix = ruleSegment.prefix ?? '';
    const rSuffix = ruleSegment.suffix ?? '';
    const tPrefix = targetSegment.prefix ?? '';
    const tSuffix = targetSegment.suffix ?? '';
    return tPrefix.startsWith(rPrefix) && tSuffix.endsWith(rSuffix);
  }
  return true;
}

function segmentsCoverAt(
  ruleSegments: readonly PatternSegment[],
  ri: number,
  targetSegments: readonly PatternSegment[],
  ti: number,
  cascade: boolean,
  memo: Map<number, boolean>,
): boolean {
  const key = ri * (targetSegments.length + 1) + ti;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let covered = false;
  if (ri === ruleSegments.length) {
    covered = ti === targetSegments.length || cascade;
  } else {
    const ruleSeg = ruleSegments[ri]!;
    if (ruleSeg.kind === 'rest') {
      if (ri === ruleSegments.length - 1) {
        covered = true;
      } else if (segmentsCoverAt(ruleSegments, ri + 1, targetSegments, ti, cascade, memo)) {
        covered = true;
      } else if (
        ti < targetSegments.length
        && segmentsCoverAt(ruleSegments, ri, targetSegments, ti + 1, cascade, memo)
      ) {
        covered = true;
      }
    } else if (ti < targetSegments.length && singleSegmentCovers(ruleSeg, targetSegments[ti]!)) {
      covered = segmentsCoverAt(ruleSegments, ri + 1, targetSegments, ti + 1, cascade, memo);
    }
  }

  memo.set(key, covered);
  return covered;
}

export function matchesConcrete(
  pattern: ResourcePattern,
  concretePath: string,
  resourceId?: string,
): boolean {
  const extracted = extractServiceHeader(pattern.service, concretePath);
  const effectiveId = resolveConcreteResourceId(pattern.service, resourceId, extracted);
  if (effectiveId === null || effectiveId !== pattern.resourceId) return false;
  const concreteSegments = parseConcreteBodySegments(extracted.bodyPath);
  if (concreteSegments === null) return false;
  return segmentsCoverAt(pattern.segments, 0, concreteSegments, 0, false, new Map());
}

export function coversPattern(
  rule: ResourcePattern,
  target: ResourcePattern,
  options?: CoversPatternOptions,
): boolean {
  if (!sameResourceScope(rule, target)) return false;
  return segmentsCoverAt(rule.segments, 0, target.segments, 0, options?.cascade === true, new Map());
}

function singleSegmentsOverlap(segA: PatternSegment, segB: PatternSegment): boolean {
  if (segA.kind === 'lit' && segB.kind === 'lit') {
    return segA.text.length > 0 && segA.text === segB.text;
  }
  if (segA.kind === 'var' && segB.kind === 'lit') return matchesVarAffixes(segA, segB.text);
  if (segA.kind === 'lit' && segB.kind === 'var') return matchesVarAffixes(segB, segA.text);
  if (segA.kind === 'var' && segB.kind === 'var') {
    const pA = segA.prefix ?? '';
    const sA = segA.suffix ?? '';
    const pB = segB.prefix ?? '';
    const sB = segB.suffix ?? '';
    return (pA.startsWith(pB) || pB.startsWith(pA)) && (sA.endsWith(sB) || sB.endsWith(sA));
  }
  return true;
}

function segmentsOverlapAt(
  segsA: readonly PatternSegment[],
  ia: number,
  segsB: readonly PatternSegment[],
  ib: number,
  cascadeA: boolean,
  cascadeB: boolean,
  memo: Map<number, boolean>,
): boolean {
  const key = ia * (segsB.length + 1) + ib;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let overlaps = false;
  if (ia === segsA.length && ib === segsB.length) {
    overlaps = true;
  } else if (ia < segsA.length && segsA[ia]!.kind === 'rest') {
    if (segmentsOverlapAt(segsA, ia + 1, segsB, ib, cascadeA, cascadeB, memo)) {
      overlaps = true;
    } else if (
      ib < segsB.length
      && isHabitableSegment(segsB[ib]!)
      && segmentsOverlapAt(segsA, ia, segsB, ib + 1, cascadeA, cascadeB, memo)
    ) {
      overlaps = true;
    } else if (ib === segsB.length && cascadeB && canInstantiateFrom(segsA, ia)) {
      overlaps = true;
    }
  } else if (ib < segsB.length && segsB[ib]!.kind === 'rest') {
    if (segmentsOverlapAt(segsA, ia, segsB, ib + 1, cascadeA, cascadeB, memo)) {
      overlaps = true;
    } else if (
      ia < segsA.length
      && isHabitableSegment(segsA[ia]!)
      && segmentsOverlapAt(segsA, ia + 1, segsB, ib, cascadeA, cascadeB, memo)
    ) {
      overlaps = true;
    } else if (ia === segsA.length && cascadeA && canInstantiateFrom(segsB, ib)) {
      overlaps = true;
    }
  } else if (ia === segsA.length) {
    overlaps = cascadeA && canInstantiateFrom(segsB, ib);
  } else if (ib === segsB.length) {
    overlaps = cascadeB && canInstantiateFrom(segsA, ia);
  } else if (singleSegmentsOverlap(segsA[ia]!, segsB[ib]!)) {
    overlaps = segmentsOverlapAt(segsA, ia + 1, segsB, ib + 1, cascadeA, cascadeB, memo);
  }

  memo.set(key, overlaps);
  return overlaps;
}

export function overlapsPattern(
  a: ResourcePattern,
  b: ResourcePattern,
  options?: OverlapsPatternOptions,
): boolean {
  if (!sameResourceScope(a, b)) return false;
  const cascadeA = options?.cascadeA === true;
  const cascadeB = options?.cascadeB === true;
  return segmentsOverlapAt(a.segments, 0, b.segments, 0, cascadeA, cascadeB, new Map());
}

function patternSegmentsEqual(a: PatternSegment, b: PatternSegment): boolean {
  if (a.kind === 'lit' && b.kind === 'lit') return a.text === b.text;
  if (a.kind === 'rest' && b.kind === 'rest') return a.name === b.name;
  if (a.kind === 'var' && b.kind === 'var') {
    return a.name === b.name && (a.prefix ?? '') === (b.prefix ?? '') && (a.suffix ?? '') === (b.suffix ?? '');
  }
  return false;
}

function patternSlicesEqual(a: readonly PatternSegment[], b: readonly PatternSegment[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!patternSegmentsEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}

function recordSliceBinding(
  bindings: Map<string, readonly PatternSegment[]>,
  name: string,
  slice: readonly PatternSegment[],
): boolean {
  const existing = bindings.get(name);
  if (existing === undefined) {
    bindings.set(name, slice);
    return true;
  }
  return patternSlicesEqual(existing, slice);
}

function unifyVarSegment(
  ruleVar: Extract<PatternSegment, { readonly kind: 'var' }>,
  siteSeg: PatternSegment,
): PatternSegment | null {
  if (siteSeg.kind === 'rest') return null;
  const rPrefix = ruleVar.prefix ?? '';
  const rSuffix = ruleVar.suffix ?? '';
  if (rPrefix.length === 0 && rSuffix.length === 0) {
    if (!isHabitableSegment(siteSeg)) return null;
    return siteSeg;
  }
  if (siteSeg.kind === 'lit') {
    if (!matchesVarAffixes(ruleVar, siteSeg.text)) return null;
    return { kind: 'lit', text: siteSeg.text.slice(rPrefix.length, siteSeg.text.length - rSuffix.length) };
  }
  const tPrefix = siteSeg.prefix ?? '';
  const tSuffix = siteSeg.suffix ?? '';
  if (!tPrefix.startsWith(rPrefix) || !tSuffix.endsWith(rSuffix)) return null;
  const innerPrefix = tPrefix.slice(rPrefix.length);
  const innerSuffix = tSuffix.slice(0, tSuffix.length - rSuffix.length);
  return buildVarSegment(siteSeg.name, innerPrefix, innerSuffix);
}

function collapseRestSlice(slice: readonly PatternSegment[]): PatternSegment {
  if (slice.length === 0) return { kind: 'lit', text: '' };
  if (slice.length === 1) return slice[0]!;

  const beforeLits: string[] = [];
  const afterLits: string[] = [];
  let singleVar: Extract<PatternSegment, { readonly kind: 'var' }> | undefined;
  let wildcardCount = 0;
  let firstWildcardName = '';

  for (const seg of slice) {
    if (seg.kind === 'lit') {
      if (wildcardCount === 0) beforeLits.push(seg.text);
      else afterLits.push(seg.text);
    } else {
      if (wildcardCount === 0) firstWildcardName = seg.name;
      wildcardCount += 1;
      if (seg.kind === 'var' && wildcardCount === 1) singleVar = seg;
      else singleVar = undefined;
    }
  }

  if (wildcardCount === 0) return { kind: 'lit', text: beforeLits.join('/') };
  if (wildcardCount === 1 && singleVar !== undefined) {
    let prefix = singleVar.prefix ?? '';
    if (beforeLits.length > 0) prefix = `${beforeLits.join('/')}/${prefix}`;
    let suffix = singleVar.suffix ?? '';
    if (afterLits.length > 0) suffix = `${suffix}/${afterLits.join('/')}`;
    return buildVarSegment(singleVar.name, prefix, suffix);
  }
  return { kind: 'rest', name: firstWildcardName };
}

function unifySegmentsAt(
  ruleSegs: readonly PatternSegment[],
  ri: number,
  siteSegs: readonly PatternSegment[],
  si: number,
  cascade: boolean,
  rawBindings: Map<string, readonly PatternSegment[]>,
): boolean {
  if (ri === ruleSegs.length) return si === siteSegs.length || cascade;
  const ruleSeg = ruleSegs[ri]!;
  if (ruleSeg.kind === 'rest') {
    if (ri === ruleSegs.length - 1) {
      return recordSliceBinding(rawBindings, ruleSeg.name, siteSegs.slice(si));
    }
    for (let end = si; end <= siteSegs.length; end += 1) {
      const candidate = new Map(rawBindings);
      if (
        recordSliceBinding(candidate, ruleSeg.name, siteSegs.slice(si, end))
        && unifySegmentsAt(ruleSegs, ri + 1, siteSegs, end, cascade, candidate)
      ) {
        rawBindings.clear();
        for (const [k, v] of candidate) rawBindings.set(k, v);
        return true;
      }
    }
    return false;
  }
  if (si >= siteSegs.length) return false;
  const siteSeg = siteSegs[si]!;
  if (ruleSeg.kind === 'lit') {
    if (siteSeg.kind !== 'lit' || siteSeg.text !== ruleSeg.text) return false;
    return unifySegmentsAt(ruleSegs, ri + 1, siteSegs, si + 1, cascade, rawBindings);
  }
  const boundVar = unifyVarSegment(ruleSeg, siteSeg);
  if (boundVar === null || !recordSliceBinding(rawBindings, ruleSeg.name, [boundVar])) {
    return false;
  }
  return unifySegmentsAt(ruleSegs, ri + 1, siteSegs, si + 1, cascade, rawBindings);
}

export function unifyPatterns(
  rule: ResourcePattern,
  site: ResourcePattern,
  options?: UnifyPatternsOptions,
): ReadonlyMap<string, PatternSegment> | null {
  if (!sameResourceScope(rule, site)) return null;
  const rawBindings = new Map<string, readonly PatternSegment[]>();
  if (!unifySegmentsAt(rule.segments, 0, site.segments, 0, options?.cascade === true, rawBindings)) {
    return null;
  }
  const collapsed = new Map<string, PatternSegment>();
  for (const [name, slice] of rawBindings) collapsed.set(name, collapseRestSlice(slice));
  return collapsed;
}
