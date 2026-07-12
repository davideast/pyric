import type {
  AssuranceProbeResult,
  AuthorizationCampaignReport,
} from "@pyric/cli/assurance";
import type { Denial } from "../rules-debug/model.js";

export interface AssuranceMatrixRow {
  id: string;
  service: AssuranceProbeResult["control"]["operation"]["service"];
  operation: string;
  actor: string;
  expected: string;
  observed: string;
  classification: AssuranceProbeResult["classification"];
  impact: string;
  supported: boolean;
}

function formatScalar(value: unknown): string {
  if (value === null) return "absent";
  if (value === undefined) return "unknown";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

export function summarizeStateDiff(result: AssuranceProbeResult): string {
  const diff = result.stateDiff;
  if (!diff) return "No state evidence";
  if (!diff.changed) {
    return result.mutation.output !== undefined
      ? "Read result captured"
      : "No state change";
  }
  if (
    diff.before &&
    diff.after &&
    typeof diff.before === "object" &&
    typeof diff.after === "object" &&
    !Array.isArray(diff.before) &&
    !Array.isArray(diff.after)
  ) {
    const before = diff.before as Record<string, unknown>;
    const after = diff.after as Record<string, unknown>;
    const changed = new Set([...Object.keys(before), ...Object.keys(after)]);
    const fields = [...changed].filter(
      (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    );
    if (fields.length > 0 && fields.length <= 3) {
      return fields
        .map(
          (field) =>
            `${field}: ${formatScalar(before[field])} -> ${formatScalar(after[field])}`,
        )
        .join(", ");
    }
  }
  return `${formatScalar(diff.before)} -> ${formatScalar(diff.after)}`;
}

export function projectAssuranceRows(
  report: AuthorizationCampaignReport,
): AssuranceMatrixRow[] {
  return report.results.map((result) => ({
    id: result.probeId,
    service: result.control.operation.service,
    operation: `${result.mutation.operation.method} ${result.mutation.operation.path}`,
    actor:
      result.actorEvidence.uid ??
      (result.actorEvidence.acquisition === "anonymous-request"
        ? "anonymous"
        : result.actorEvidence.actorId),
    expected: result.invariant.expected,
    observed: result.mutation.decision,
    classification: result.classification,
    impact: summarizeStateDiff(result),
    supported: result.qualification.supported,
  }));
}

export function toRuleDecision(result: AssuranceProbeResult): Denial | null {
  const event = result.mutation.events.find(
    (item) =>
      item.result === "allow" ||
      item.result === "deny" ||
      item.result === "unsupported",
  );
  if (!event) return null;
  const verdict = event.result as "allow" | "deny" | "unsupported";
  const denial: Denial = {
    id: event.id ?? `${result.probeId}-decision`,
    at: event.at ?? 0,
    result: verdict,
    method: event.method ?? event.op ?? result.mutation.operation.method,
    service: event.service ?? result.mutation.operation.service,
    path: event.path ?? result.mutation.operation.path,
    auth: (event.auth ?? null) as Denial["auth"],
    reasons: event.reasons ?? [],
    origin: (event.origin ?? "user") as Denial["origin"],
    unsupported: verdict === "unsupported",
  };
  if (event.matchedRule)
    denial.matchedRule = event.matchedRule as Denial["matchedRule"];
  if (event.evaluatedRule) {
    denial.evaluatedRule = event.evaluatedRule as Denial["evaluatedRule"];
  }
  if (event.rules) denial.rules = event.rules as Denial["rules"];
  if (event.resourceBefore) {
    denial.resourceBefore = event.resourceBefore as Denial["resourceBefore"];
  }
  const request = event.request as
    { resourceData?: unknown; data?: unknown } | undefined;
  const resourceData = request?.resourceData ?? request?.data;
  if (resourceData !== undefined) denial.resourceData = resourceData;
  return denial;
}
