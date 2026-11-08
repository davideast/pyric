/**
 * Static missing-index and literal-sibling wildcard-shadowing verifier
 * (`checkRtdbIndexes`) over compiled Realtime Database security rules.
 */
import { compileRtdbRules } from '../../rules/rtdb/compiled-rules.js';
import { findMatchingNodesAtPath, nodesDeclaringIndex } from '../../rules/rtdb/index-lookup.js';
import type { RtdbNode } from '../../rules/rtdb/types.js';
import {
  sortAssuranceDiagnostics,
  type AssuranceDiagnostic,
} from '../../sandbox/internal/assurance-diagnostic.js';
import {
  parseResourcePattern,
  type PatternSegment,
} from '../../sandbox/internal/resource-pattern.js';
import { sanitizeWildcardName, type RtdbIndexRequirement } from './rtdb-indexes.js';
import { parseOrCloneRulesRoot } from './rtdb-rules-merge.js';

const MAX_CANDIDATE_PROBES = 64;

interface ProbeCandidate {
  readonly probeSegments: string[];
  readonly displaySegments: string[];
  readonly shadowedByLiteral: string | undefined;
}

function chooseWildcardProbeToken(literalChildren: ReadonlySet<string>): string {
  let token = '__pyric_wildcard__';
  while (literalChildren.has(token)) token = `${token}_`;
  return token;
}

function collectProbeCandidates(
  compiledRoot: RtdbNode,
  segments: readonly PatternSegment[],
): ProbeCandidate[] {
  let candidates: ProbeCandidate[] = [
    { probeSegments: [], displaySegments: [], shadowedByLiteral: undefined },
  ];
  for (const seg of segments) {
    const next: ProbeCandidate[] = [];
    for (const cand of candidates) {
      if (seg.kind === 'lit') {
        next.push({
          probeSegments: [...cand.probeSegments, seg.text],
          displaySegments: [...cand.displaySegments, seg.text],
          shadowedByLiteral: cand.shadowedByLiteral,
        });
        continue;
      }
      const literalNames = new Set<string>();
      const wildcardNames = new Set<string>();
      for (const parent of findMatchingNodesAtPath(compiledRoot, cand.probeSegments)) {
        for (const child of parent.children) {
          const childSegs = child.path.split('/').filter((s) => s.length > 0);
          const lastSeg = childSegs[childSegs.length - 1];
          if (!lastSeg) continue;
          if (lastSeg.startsWith('$')) {
            wildcardNames.add(lastSeg);
          } else {
            literalNames.add(lastSeg);
          }
        }
      }
      const sortedWildcards = [...wildcardNames].sort();
      const displayWildcard = sortedWildcards[0] ?? `$${sanitizeWildcardName(seg.name)}`;
      next.push({
        probeSegments: [...cand.probeSegments, chooseWildcardProbeToken(literalNames)],
        displaySegments: [...cand.displaySegments, displayWildcard],
        shadowedByLiteral: cand.shadowedByLiteral,
      });
      for (const litName of [...literalNames].sort()) {
        if (next.length >= MAX_CANDIDATE_PROBES) break;
        const shadowPath = [...cand.displaySegments, litName].join('/');
        next.push({
          probeSegments: [...cand.probeSegments, litName],
          displaySegments: [...cand.displaySegments, litName],
          shadowedByLiteral: cand.shadowedByLiteral ?? shadowPath,
        });
      }
    }
    candidates = next.slice(0, MAX_CANDIDATE_PROBES);
  }
  return candidates;
}

function buildMissingIndexDiagnostic(
  req: RtdbIndexRequirement,
  displayPath: string,
  ruleLocation: string,
  target: string,
  shadowedByLiteral: string | undefined,
): AssuranceDiagnostic {
  let message = `Missing RTDB .indexOn "${target}" at "${ruleLocation}" required by client query.`;
  if (shadowedByLiteral !== undefined) {
    message = `Missing RTDB .indexOn "${target}" at "${ruleLocation}": literal rule branch "/${shadowedByLiteral}" shadows wildcard rules and does not inherit ".indexOn".`;
  }
  const base = {
    id: `rtdb-missing-index-on:${req.resourceId}:${displayPath}:${target}`,
    code: 'rtdb-missing-index-on',
    service: 'rtdb' as const,
    resourceId: req.resourceId,
    severity: 'medium' as const,
    certainty: 'static-proof' as const,
    message,
    resource: parseResourcePattern('rtdb', displayPath, req.resourceId),
    ruleSite: { source: ruleLocation },
    remediation: `Add "${target}" to ".indexOn" at "${ruleLocation}" in database.rules.json.`,
  };
  const primarySource = req.sources[0];
  if (primarySource !== undefined) {
    return { ...base, codeSite: { source: primarySource } };
  }
  return base;
}

export function checkRtdbIndexes(
  rulesSourceOrJson: string | Record<string, unknown> | undefined,
  requirements: readonly RtdbIndexRequirement[],
): AssuranceDiagnostic[] {
  const root = parseOrCloneRulesRoot(rulesSourceOrJson);
  const compiled = compileRtdbRules(root);
  const diagnostics: AssuranceDiagnostic[] = [];

  for (const req of requirements) {
    if (req.indexOn.length === 0 || req.pattern.segments.some((s) => s.kind === 'rest')) continue;
    for (const candidate of collectProbeCandidates(compiled, req.pattern.segments)) {
      const displayPath = candidate.displaySegments.join('/');
      let ruleLocation = '/';
      if (displayPath.length > 0) {
        ruleLocation = `/${displayPath}`;
      }
      for (const target of req.indexOn) {
        if (nodesDeclaringIndex(compiled, candidate.probeSegments, target).length > 0) continue;
        diagnostics.push(
          buildMissingIndexDiagnostic(
            req,
            displayPath,
            ruleLocation,
            target,
            candidate.shadowedByLiteral,
          ),
        );
      }
    }
  }
  return sortAssuranceDiagnostics(diagnostics);
}
