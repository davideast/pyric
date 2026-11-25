import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Surface } from '../registry/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(HERE, '..', '..', '..');

/** Where a change adds `<row-id>.md`, `<surface>.surface.md`, or `<surface>.breadth.md` to accept a deliberate shift. */
export const ACCEPTANCES_DIR = 'packages/conformance/coverage-acceptances';

interface NamespaceBaseline {
  mapped: number;
  denominator: number;
  pct: number;
}

interface SurfaceCoverageBaseline {
  runtime: NamespaceBaseline;
  types: NamespaceBaseline;
}

interface EntryPathBaselineSummary {
  program: string;
  verdict: 'green' | 'red-known' | 'red' | 'stale-expected-failure';
}

/** Structural subset of CoverageReport read from `--base-report`, kept backwards-compatible across report schema extensions. */
export interface CoverageBaseline {
  services: ReadonlyArray<{ surface: Surface; surfaceCoverage: SurfaceCoverageBaseline | null }>;
  overall: { surfaceCoverage: SurfaceCoverageBaseline };
  orphanObservations: readonly string[];
  highRiskUnverified: readonly string[];
  rowStatuses: Readonly<Record<string, string>>;
  entryPath: readonly EntryPathBaselineSummary[];
}

/**
 * One acceptance file. A row-scoped file (`<row-id>.md` or `<row-id>.<pr-or-issue>.md`)
 * sets `rowId` and excuses that single row's demotion or removal. A surface-scoped file
 * (`<surface>.surface.md` or `<surface>.surface.<pr-or-issue>.md`) sets `surface` and
 * excuses `conforms -> unverified` demotions within that surface when at least one row
 * in that surface underwent such a demotion. A breadth-scoped file (`<surface>.breadth.md`
 * or `<surface>.breadth.<pr-or-issue>.md`) sets `breadthSurface` and excuses a public
 * runtime/type breadth percentage drop caused solely by an upstream SDK denominator shift
 * when zero still-existing mapped exports were dropped.
 * Only files the change adds count (`loadAddedAcceptances`).
 */
export interface CoverageAcceptance {
  rowId?: string;
  surface?: string;
  breadthSurface?: string;
  /** Repo-relative path, as the change added it. */
  path: string;
  text: string;
}

const ROW_ACCEPTANCE_NAME = /^([A-Za-z0-9._-]+#[A-Za-z0-9._-]+?)(?:\.\d+)?\.md$/;
const SURFACE_ACCEPTANCE_NAME = /^([A-Za-z0-9_-]+)\.surface(?:\.\d+)?\.md$/;
const BREADTH_ACCEPTANCE_NAME = /^([A-Za-z0-9_-]+)\.breadth(?:\.\d+)?\.md$/;
const ISSUE_REFERENCE = /#\d+|https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+/;
const CONFORMING_DEMOTION = new Set(['bug', 'diverged-documented', 'unverified', 'unsupported']);

function validateAcceptanceBody(path: string, text: string): void {
  if (text.trim() === '') throw new Error(`${path} is empty: give the reason and the issue`);
  if (!ISSUE_REFERENCE.test(text)) throw new Error(`${path} names no issue: add #<n> or the issue's URL`);
  const reason = text.replace(new RegExp(ISSUE_REFERENCE.source, 'g'), '').replace(/[\s.,;:()-]/g, '');
  if (reason === '') throw new Error(`${path} gives no reason: say why the row may regress`);
}

export function parseAcceptance(path: string, text: string): CoverageAcceptance {
  const inSubdirectory = dirname(path) !== ACCEPTANCES_DIR;
  if (inSubdirectory) {
    throw new Error(`${path} is in a subdirectory: put it directly in ${ACCEPTANCES_DIR}/`);
  }
  const fileName = basename(path);
  const rowMatch = ROW_ACCEPTANCE_NAME.exec(fileName);
  if (rowMatch) {
    validateAcceptanceBody(path, text);
    return { rowId: rowMatch[1], path, text };
  }
  const surfaceMatch = SURFACE_ACCEPTANCE_NAME.exec(fileName);
  if (surfaceMatch) {
    validateAcceptanceBody(path, text);
    return { surface: surfaceMatch[1], path, text };
  }
  const breadthMatch = BREADTH_ACCEPTANCE_NAME.exec(fileName);
  if (breadthMatch) {
    const breadthSurface = breadthMatch[1];
    if (breadthSurface === 'overall') {
      throw new Error(`${path} cannot target overall directly: name each constituent mirror surface instead`);
    }
    validateAcceptanceBody(path, text);
    return { breadthSurface, path, text };
  }
  throw new Error(
    `${path} is not named <row-id>.md or <row-id>.<pr-or-issue>.md (or <surface>.surface.md / <surface>.breadth.md)`,
  );
}

/** The acceptance files HEAD adds relative to `baseCommit`. An edit or a rename target that already existed does not count. */
export function loadAddedAcceptances(baseCommit: string, repoRoot: string = DEFAULT_REPO_ROOT): CoverageAcceptance[] {
  const added = execFileSync(
    'git',
    ['diff', '-z', '--no-renames', '--diff-filter=A', '--name-only', baseCommit, 'HEAD', '--', ACCEPTANCES_DIR],
    { cwd: repoRoot, encoding: 'utf8' },
  ).split('\0').filter((path) => path !== '');
  return added.map((path) => parseAcceptance(path, readFileSync(join(repoRoot, path), 'utf8')));
}

interface RowRegression {
  message: string;
  surface: string;
  isConformsToUnverified: boolean;
}

function surfaceOfRowId(id: string): string {
  const hashIndex = id.indexOf('#');
  if (hashIndex === -1) return '';
  return id.slice(0, hashIndex);
}

function rowRegressions(base: CoverageBaseline, head: CoverageBaseline): Map<string, RowRegression> {
  const regressed = new Map<string, RowRegression>();
  for (const [id, baseStatus] of Object.entries(base.rowStatuses)) {
    const headStatus = head.rowStatuses[id];
    const surface = surfaceOfRowId(id);
    if (headStatus === undefined) {
      regressed.set(id, {
        message: `${id}: was '${baseStatus}', row removed from the registry`,
        surface,
        isConformsToUnverified: false,
      });
    } else if (baseStatus === 'conforms' && CONFORMING_DEMOTION.has(headStatus)) {
      regressed.set(id, {
        message: `${id}: was 'conforms', now '${headStatus}'`,
        surface,
        isConformsToUnverified: headStatus === 'unverified',
      });
    }
  }
  return regressed;
}

function preservesExistingMappedExports(from: NamespaceBaseline, to: NamespaceBaseline): boolean {
  const maxUpstreamRemovals = Math.max(0, from.denominator - to.denominator);
  return to.mapped >= from.mapped - maxUpstreamRemovals;
}

function isDenominatorOnlyBreadthShift(
  from: SurfaceCoverageBaseline,
  to: SurfaceCoverageBaseline,
): boolean {
  const pctDropped = to.runtime.pct < from.runtime.pct || to.types.pct < from.types.pct;
  if (!pctDropped) return false;
  return (
    preservesExistingMappedExports(from.runtime, to.runtime) &&
    preservesExistingMappedExports(from.types, to.types)
  );
}

function surfaceRegressions(
  base: CoverageBaseline,
  head: CoverageBaseline,
  acceptedBreadthSurfaces: ReadonlySet<string>,
): { problems: string[]; excusedBreadthSurfaces: Set<string> } {
  const problems: string[] = [];
  const excusedBreadthSurfaces = new Set<string>();
  const dropped = (label: string, from: SurfaceCoverageBaseline, to: SurfaceCoverageBaseline): void => {
    if (to.runtime.pct < from.runtime.pct) {
      problems.push(`${label}: public runtime surface dropped ${from.runtime.pct}% -> ${to.runtime.pct}%`);
    }
    if (to.types.pct < from.types.pct) {
      problems.push(`${label}: public type surface dropped ${from.types.pct}% -> ${to.types.pct}%`);
    }
  };

  let unexcusedServicePctDrop = false;
  let mirrorServiceLostMappedExport = false;
  let totalUpstreamRuntimeRemovals = 0;
  let totalUpstreamTypeRemovals = 0;

  const baseServices = new Map(base.services.map((s) => [s.surface, s]));
  for (const s of head.services) {
    const baseSurface = baseServices.get(s.surface)?.surfaceCoverage;
    if (!baseSurface || !s.surfaceCoverage) continue;
    const keepsRuntime = preservesExistingMappedExports(baseSurface.runtime, s.surfaceCoverage.runtime);
    const keepsTypes = preservesExistingMappedExports(baseSurface.types, s.surfaceCoverage.types);
    if (!keepsRuntime || !keepsTypes) {
      mirrorServiceLostMappedExport = true;
    } else {
      totalUpstreamRuntimeRemovals += Math.max(0, baseSurface.runtime.denominator - s.surfaceCoverage.runtime.denominator);
      totalUpstreamTypeRemovals += Math.max(0, baseSurface.types.denominator - s.surfaceCoverage.types.denominator);
    }
    const pctDropped =
      s.surfaceCoverage.runtime.pct < baseSurface.runtime.pct ||
      s.surfaceCoverage.types.pct < baseSurface.types.pct;
    if (!pctDropped) continue;
    if (acceptedBreadthSurfaces.has(s.surface) && isDenominatorOnlyBreadthShift(baseSurface, s.surfaceCoverage)) {
      excusedBreadthSurfaces.add(s.surface);
    } else {
      unexcusedServicePctDrop = true;
      dropped(s.surface, baseSurface, s.surfaceCoverage);
    }
  }

  const overallFrom = base.overall.surfaceCoverage;
  const overallTo = head.overall.surfaceCoverage;
  const overallPctDropped =
    overallTo.runtime.pct < overallFrom.runtime.pct ||
    overallTo.types.pct < overallFrom.types.pct;
  if (overallPctDropped) {
    const overallKeepsRuntime = overallTo.runtime.mapped >= overallFrom.runtime.mapped - totalUpstreamRuntimeRemovals;
    const overallKeepsTypes = overallTo.types.mapped >= overallFrom.types.mapped - totalUpstreamTypeRemovals;
    const overallExcused =
      excusedBreadthSurfaces.size > 0 &&
      !unexcusedServicePctDrop &&
      !mirrorServiceLostMappedExport &&
      overallKeepsRuntime &&
      overallKeepsTypes;
    if (!overallExcused) {
      dropped('overall', overallFrom, overallTo);
    }
  }

  return { problems, excusedBreadthSurfaces };
}

function entryPathRegressions(base: CoverageBaseline, head: CoverageBaseline): string[] {
  const problems: string[] = [];
  const headVerdicts = new Map(head.entryPath.map((p) => [p.program, p.verdict]));
  for (const { program, verdict } of base.entryPath) {
    if (verdict !== 'green') continue;
    const headVerdict = headVerdicts.get(program);
    if (headVerdict === undefined) {
      problems.push(`entry-path '${program}': was green, program removed from the corpus`);
    } else if (headVerdict !== 'green') {
      problems.push(`entry-path '${program}': was green, now '${headVerdict}' (a cliff regression, never tolerated)`);
    }
  }
  return problems;
}

export function findRegressions(
  base: CoverageBaseline,
  head: CoverageBaseline,
  acceptances: readonly CoverageAcceptance[],
): string[] {
  const acceptedRows = new Set<string>();
  const acceptedSurfaces = new Set<string>();
  const acceptedBreadthSurfaces = new Set<string>();
  for (const acceptance of acceptances) {
    if (acceptance.rowId !== undefined) acceptedRows.add(acceptance.rowId);
    if (acceptance.surface !== undefined) acceptedSurfaces.add(acceptance.surface);
    if (acceptance.breadthSurface !== undefined) acceptedBreadthSurfaces.add(acceptance.breadthSurface);
  }

  const { problems, excusedBreadthSurfaces } = surfaceRegressions(base, head, acceptedBreadthSurfaces);
  const regressedRows = rowRegressions(base, head);

  const demotedCountBySurface = new Map<string, number>();
  for (const [id, reg] of regressedRows) {
    if (reg.isConformsToUnverified) {
      demotedCountBySurface.set(reg.surface, (demotedCountBySurface.get(reg.surface) ?? 0) + 1);
    }
    const excusedByRow = acceptedRows.has(id);
    const excusedBySurface = reg.isConformsToUnverified && acceptedSurfaces.has(reg.surface);
    if (!excusedByRow && !excusedBySurface) {
      problems.push(reg.message);
    }
  }

  for (const acceptance of acceptances) {
    if (acceptance.rowId !== undefined && !regressedRows.has(acceptance.rowId)) {
      problems.push(`${acceptance.path} names '${acceptance.rowId}', which did not regress against the base report`);
    }
    if (acceptance.surface !== undefined && (demotedCountBySurface.get(acceptance.surface) ?? 0) === 0) {
      problems.push(
        `${acceptance.path} names surface '${acceptance.surface}', which had no 'conforms' -> 'unverified' demotions against the base report`,
      );
    }
    if (acceptance.breadthSurface !== undefined && !excusedBreadthSurfaces.has(acceptance.breadthSurface)) {
      problems.push(
        `${acceptance.path} names surface '${acceptance.breadthSurface}', which had no upstream-denominator breadth drop against the base report`,
      );
    }
  }

  const baseOrphans = new Set(base.orphanObservations);
  const newOrphans = head.orphanObservations.filter((o) => !baseOrphans.has(o));
  if (newOrphans.length > 0) problems.push(`${newOrphans.length} NEW orphan observation(s): ${newOrphans.join(', ')}`);

  if (head.highRiskUnverified.length > base.highRiskUnverified.length) {
    problems.push(`high-risk unverified rows increased: ${base.highRiskUnverified.length} -> ${head.highRiskUnverified.length}`);
  }

  problems.push(...entryPathRegressions(base, head));
  return problems;
}
