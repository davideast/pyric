/**
 * Stateless Realtime Database `.indexOn` extraction pass (`rtdbIndexPass`).
 */
import {
  parseResourcePattern,
  type PatternSegment,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import { DEFAULT_RESOURCE_ID } from '../../sandbox/internal/resource-pattern-header.js';
import type { SdkUsageIndex } from '../code/usage-index.js';
import { formatSourceAtLine, splitSourceLocation } from './source-location.js';

export interface RtdbIndexPassOptions {
  /** Scope extracted `.indexOn` requirements to one RTDB instance (`'(default)'`, name, or URL). */
  readonly instance?: string;
  /** Also include `'(default)'` queries when `instance` names the project's default RTDB instance. */
  readonly includeDefaultInstance?: boolean;
}

export interface RtdbIndexRequirement {
  readonly resourceId: string;
  readonly pattern: ResourcePattern;
  readonly path: string;
  readonly indexOn: readonly string[];
  readonly sources: readonly string[];
}

export interface RtdbIndexWarning {
  readonly file: string;
  readonly line?: number;
  readonly code: 'unresolved-query' | 'dynamic-order-field';
  readonly message: string;
}

export interface RtdbIndexPassResult {
  readonly requirements: readonly RtdbIndexRequirement[];
  readonly byInstance: Readonly<Record<string, readonly RtdbIndexRequirement[]>>;
  readonly warnings: readonly RtdbIndexWarning[];
}

interface RequirementAccumulator {
  readonly resourceId: string;
  readonly segments: PatternSegment[];
  readonly path: string;
  readonly indexOn: Set<string>;
  readonly sources: Set<string>;
}

export function sanitizeWildcardName(rawName: string): string {
  const cleaned = rawName.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+/, '');
  if (cleaned.length > 0) return cleaned;
  return 'id';
}

export function normalizeIndexTarget(rawTarget: string): string {
  if (rawTarget === '.value') return '.value';
  return rawTarget.split('/').filter((seg) => seg.length > 0).join('/');
}

function appendWarning(
  warnings: RtdbIndexWarning[],
  file: string,
  line: number | undefined,
  code: RtdbIndexWarning['code'],
  message: string,
): void {
  if (line !== undefined) {
    warnings.push({ file, line, code, message });
    return;
  }
  warnings.push({ file, code, message });
}

function canonicalRtdbSegments(segments: readonly PatternSegment[]): {
  shapeKey: string;
  normalizedSegments: PatternSegment[];
  rulePath: string;
} {
  const shapeParts: string[] = [];
  const normalizedSegments: PatternSegment[] = [];
  const pathParts: string[] = [];
  for (const seg of segments) {
    if (seg.kind === 'lit') {
      shapeParts.push(`L:${seg.text}`);
      normalizedSegments.push({ kind: 'lit', text: seg.text });
      pathParts.push(seg.text);
    } else {
      const cleanName = sanitizeWildcardName(seg.name);
      shapeParts.push('V');
      normalizedSegments.push({ kind: 'var', name: cleanName });
      pathParts.push(`$${cleanName}`);
    }
  }
  return { shapeKey: shapeParts.join('/'), normalizedSegments, rulePath: pathParts.join('/') };
}

export function rtdbIndexPass(
  usage: SdkUsageIndex,
  options?: RtdbIndexPassOptions,
): RtdbIndexPassResult {
  let targetResourceId: string | undefined;
  if (options?.instance !== undefined) {
    targetResourceId = parseResourcePattern('rtdb', '', options.instance).resourceId;
  }

  const accumulators = new Map<string, RequirementAccumulator>();
  const warnings: RtdbIndexWarning[] = [];

  for (const q of usage.queries) {
    const pattern = q.baseRef.pattern;
    if (pattern.service !== 'rtdb') continue;
    if (targetResourceId !== undefined) {
      const matchesTarget = pattern.resourceId === targetResourceId;
      const matchesDefaultAlias =
        options?.includeDefaultInstance === true && pattern.resourceId === DEFAULT_RESOURCE_ID;
      if (!matchesTarget && !matchesDefaultAlias) continue;
    }

    const { file, line } = splitSourceLocation(q.source);
    if (q.baseRef.resolution === 'unresolved' || pattern.segments.some((s) => s.kind === 'rest')) {
      const atLine = formatSourceAtLine(line);
      appendWarning(
        warnings,
        file,
        line,
        'unresolved-query',
        `RTDB query(...)${atLine} could not resolve a concrete or single-segment wildcard ref (${q.baseRef.reason ?? 'unresolved'}); no .indexOn entry was generated.`,
      );
      continue;
    }

    const branches = q.branches ?? [q.constraints];
    const queryTargets = new Set<string>();
    let sawDynamicOrderField = false;

    for (const branch of branches) {
      for (const constraint of branch) {
        if (constraint.kind === 'orderByValue') {
          queryTargets.add('.value');
        } else if (constraint.kind === 'orderByChild') {
          if (constraint.field === undefined) {
            sawDynamicOrderField = true;
            continue;
          }
          const normalizedField = normalizeIndexTarget(constraint.field);
          if (normalizedField.length === 0 || normalizedField === '.value') {
            sawDynamicOrderField = true;
            continue;
          }
          queryTargets.add(normalizedField);
        }
      }
    }

    const canonical = canonicalRtdbSegments(pattern.segments);
    if (sawDynamicOrderField) {
      let atPath = '/';
      if (canonical.rulePath.length > 0) {
        atPath = `/${canonical.rulePath}`;
      }
      appendWarning(
        warnings,
        file,
        line,
        'dynamic-order-field',
        `RTDB query on '${atPath}' passed a non-literal field to orderByChild(...); that ordering was skipped.`,
      );
    }
    if (queryTargets.size === 0) continue;

    const groupKey = `${pattern.resourceId}|${canonical.shapeKey}`;
    let acc = accumulators.get(groupKey);
    if (!acc) {
      acc = {
        resourceId: pattern.resourceId,
        segments: canonical.normalizedSegments,
        path: canonical.rulePath,
        indexOn: new Set<string>(),
        sources: new Set<string>(),
      };
      accumulators.set(groupKey, acc);
    }
    for (const target of queryTargets) acc.indexOn.add(target);
    acc.sources.add(q.source);
  }

  const requirements: RtdbIndexRequirement[] = [...accumulators.values()]
    .map((acc) => ({
      resourceId: acc.resourceId,
      pattern: { service: 'rtdb' as const, resourceId: acc.resourceId, segments: acc.segments },
      path: acc.path,
      indexOn: [...acc.indexOn].sort(),
      sources: [...acc.sources].sort(),
    }))
    .sort((a, b) => a.resourceId.localeCompare(b.resourceId) || a.path.localeCompare(b.path));

  const byInstance: Record<string, RtdbIndexRequirement[]> = Object.create(null) as Record<
    string,
    RtdbIndexRequirement[]
  >;
  for (const req of requirements) {
    let list = byInstance[req.resourceId];
    if (!list) {
      list = [];
      byInstance[req.resourceId] = list;
    }
    list.push(req);
  }

  return { requirements, byInstance, warnings };
}
