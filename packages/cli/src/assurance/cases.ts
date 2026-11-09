import { runAuthorizationCampaign } from "./runner.js";
import {
  ASSURANCE_CAMPAIGN_SCHEMA,
  type AssuranceActor,
  type AuthorizationCampaignReport,
  type LocalFirebaseTarget,
  type SecurityCase,
  type SecurityInvariant,
} from "./types.js";

export interface RunSecurityCasesInput {
  campaignId: string;
  target: LocalFirebaseTarget;
  actors: AssuranceActor[];
  cases: SecurityCase[];
}

function sameInvariant(a: SecurityInvariant, b: SecurityInvariant): boolean {
  return (
    a.id === b.id &&
    a.statement === b.statement &&
    a.service === b.service &&
    a.expected === b.expected &&
    a.source === b.source &&
    a.confidence === b.confidence
  );
}

/**
 * Re-run exported expectations against a candidate local target. Each case
 * keeps its known-good control and explicit negative expectation, so a rules
 * change must preserve the application workflow and reject the boundary case.
 */
export async function runSecurityCases(
  input: RunSecurityCasesInput,
): Promise<AuthorizationCampaignReport> {
  const invariants = new Map<string, SecurityInvariant>();
  const probeInvariantIds = new Map<number, string>();
  const publicInvariantsByProbeId = new Map<string, SecurityInvariant>();

  for (const [index, item] of input.cases.entries()) {
    const effectiveInvariant: SecurityInvariant = {
      ...item.invariant,
      expected: item.expect ?? item.invariant.expected,
    };
    const baseId = effectiveInvariant.id;
    const existing = invariants.get(baseId);
    if (!existing) {
      invariants.set(baseId, effectiveInvariant);
      probeInvariantIds.set(index, baseId);
      publicInvariantsByProbeId.set(item.id, effectiveInvariant);
    } else if (sameInvariant(existing, effectiveInvariant)) {
      probeInvariantIds.set(index, baseId);
      publicInvariantsByProbeId.set(item.id, effectiveInvariant);
    } else {
      let disambiguatedId = `${baseId}__case_${index}`;
      let suffix = index;
      while (invariants.has(disambiguatedId)) {
        suffix += 1;
        disambiguatedId = `${baseId}__case_${suffix}`;
      }
      invariants.set(disambiguatedId, {
        ...effectiveInvariant,
        id: disambiguatedId,
      });
      probeInvariantIds.set(index, disambiguatedId);
      publicInvariantsByProbeId.set(item.id, effectiveInvariant);
    }
  }

  const report = await runAuthorizationCampaign({
    schema: ASSURANCE_CAMPAIGN_SCHEMA,
    id: input.campaignId,
    target: input.target,
    actors: input.actors,
    invariants: [...invariants.values()],
    probes: input.cases.map((item, index) => ({
      id: item.id,
      actorId: item.actorId,
      invariantId: probeInvariantIds.get(index) ?? item.invariant.id,
      control: item.control,
      mutation: item.mutation,
      ...(item.requires ? { requires: item.requires } : {}),
    })),
  });

  return {
    ...report,
    results: report.results.map((result) => ({
      ...result,
      invariant:
        publicInvariantsByProbeId.get(result.probeId) ?? result.invariant,
    })),
  };
}
