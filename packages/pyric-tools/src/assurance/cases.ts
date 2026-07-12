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

/**
 * Re-run exported expectations against a candidate local target. Each case
 * keeps its known-good control and explicit negative expectation, so a rules
 * change must preserve the application workflow and reject the boundary case.
 */
export function runSecurityCases(
  input: RunSecurityCasesInput,
): Promise<AuthorizationCampaignReport> {
  const invariants = new Map<string, SecurityInvariant>();
  for (const item of input.cases)
    invariants.set(item.invariant.id, item.invariant);
  return runAuthorizationCampaign({
    schema: ASSURANCE_CAMPAIGN_SCHEMA,
    id: input.campaignId,
    target: input.target,
    actors: input.actors,
    invariants: [...invariants.values()],
    probes: input.cases.map((item) => ({
      id: item.id,
      actorId: item.actorId,
      invariantId: item.invariant.id,
      control: item.control,
      mutation: item.mutation,
    })),
  });
}
