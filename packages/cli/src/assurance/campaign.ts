import { runAuthorizationCampaign } from "./runner.js";
import { runSecurityCases } from "./cases.js";
import {
  assertActor,
  assertInvariant,
  assertObservation,
  assertProbe,
  assertTarget,
} from "./validation.js";
import {
  ASSURANCE_CAMPAIGN_SCHEMA,
  AssuranceInputError,
  type AssuranceActor,
  type AssuranceCampaignContext,
  type AssuranceObservation,
  type AssuranceProbe,
  type AssuranceProbeResult,
  type AssuranceVisualizationSnapshot,
  type AuthorizationCampaignReport,
  type AuthorizationCampaignSpec,
  type CampaignExport,
  type LocalFirebaseTarget,
  type MinimizationResult,
  type ProposalInput,
  type SecurityCase,
  type SecurityInvariant,
} from "./types.js";

export interface CreateAuthorizationCampaignOptions {
  id: string;
  target: LocalFirebaseTarget;
  context?: AssuranceCampaignContext;
  safety?: {
    network?: "forbid";
    maxRuns?: number;
  };
}

export class AuthorizationCampaign {
  readonly id: string;
  readonly target: LocalFirebaseTarget;
  readonly context: AssuranceCampaignContext | undefined;
  readonly maxRuns: number;

  #actors = new Map<string, AssuranceActor>();
  #invariants = new Map<string, SecurityInvariant>();
  #observations = new Map<string, AssuranceObservation>();
  #probes = new Map<string, AssuranceProbe>();
  #report: AuthorizationCampaignReport | undefined;
  #verifications: AuthorizationCampaignReport[] = [];
  #runs = 0;

  constructor(options: CreateAuthorizationCampaignOptions) {
    if (!options.id.trim())
      throw new AssuranceInputError("campaign id is required.");
    assertTarget(options.target);
    this.id = options.id;
    this.target = options.target;
    this.context = options.context;
    const maxRuns = options.safety?.maxRuns ?? 200;
    if (!Number.isInteger(maxRuns) || maxRuns <= 0) {
      throw new AssuranceInputError(
        "campaign maxRuns must be a positive integer.",
      );
    }
    this.maxRuns = maxRuns;
  }

  addActor(actor: AssuranceActor): AssuranceActor {
    assertActor(actor);
    this.#addUnique(this.#actors, actor, "actor");
    return actor;
  }

  addInvariant(invariant: SecurityInvariant): SecurityInvariant {
    assertInvariant(invariant);
    this.#addUnique(this.#invariants, invariant, "invariant");
    return invariant;
  }

  addObservation(observation: AssuranceObservation): AssuranceObservation {
    assertObservation(observation);
    if (!this.#actors.has(observation.actorId)) {
      throw new AssuranceInputError(
        `observation '${observation.id}' references unknown actor '${observation.actorId}'.`,
      );
    }
    this.#addUnique(this.#observations, observation, "observation");
    return observation;
  }

  addProbe(probe: AssuranceProbe): AssuranceProbe {
    assertProbe(probe);
    if (!this.#actors.has(probe.actorId)) {
      throw new AssuranceInputError(
        `probe '${probe.id}' references unknown actor '${probe.actorId}'.`,
      );
    }
    const invariant = this.#invariants.get(probe.invariantId);
    if (!invariant) {
      throw new AssuranceInputError(
        `probe '${probe.id}' references unknown invariant '${probe.invariantId}'.`,
      );
    }
    if (
      invariant.service !== "cross-service" &&
      invariant.service !== probe.control.service
    ) {
      throw new AssuranceInputError(
        `probe '${probe.id}' service does not match invariant '${invariant.id}'.`,
      );
    }
    this.#addUnique(this.#probes, probe, "probe");
    return probe;
  }

  propose(input: ProposalInput): AssuranceProbe[] {
    if (!input || typeof input !== "object") {
      throw new AssuranceInputError("proposal input must be an object.");
    }
    if (
      typeof input.observationId !== "string" ||
      !input.observationId.trim()
    ) {
      throw new AssuranceInputError("proposal observationId is required.");
    }
    if (typeof input.invariantId !== "string" || !input.invariantId.trim()) {
      throw new AssuranceInputError("proposal invariantId is required.");
    }
    if (!Array.isArray(input.mutations)) {
      throw new AssuranceInputError("proposal mutations must be an array.");
    }
    const observation = this.#observations.get(input.observationId);
    if (!observation) {
      throw new AssuranceInputError(
        `unknown observation '${input.observationId}'.`,
      );
    }
    if (!this.#invariants.has(input.invariantId)) {
      throw new AssuranceInputError(
        `unknown invariant '${input.invariantId}'.`,
      );
    }
    if (input.mutations.length === 0) {
      throw new AssuranceInputError("at least one mutation is required.");
    }

    return input.mutations.map((mutation, index) => {
      const id =
        mutation.id ??
        `${input.observationId}-${mutation.dimension}-${index + 1}`;
      const probe: AssuranceProbe = {
        id,
        actorId: observation.actorId,
        invariantId: input.invariantId,
        control: observation.operation,
        mutation: {
          dimension: mutation.dimension,
          description: mutation.description,
          operation: mutation.operation,
        },
      };
      return this.addProbe(probe);
    });
  }

  spec(probeIds?: string[]): AuthorizationCampaignSpec {
    const probes = probeIds
      ? probeIds.map((id) => {
          const probe = this.#probes.get(id);
          if (!probe) throw new AssuranceInputError(`unknown probe '${id}'.`);
          return probe;
        })
      : [...this.#probes.values()];
    return {
      schema: ASSURANCE_CAMPAIGN_SCHEMA,
      id: this.id,
      target: this.target,
      actors: [...this.#actors.values()],
      invariants: [...this.#invariants.values()],
      probes,
    };
  }

  async run(probeIds?: string[]): Promise<AuthorizationCampaignReport> {
    const count = probeIds?.length ?? this.#probes.size;
    this.#assertRunBudget(count);
    const report = await runAuthorizationCampaign(this.spec(probeIds));
    this.#runs += count;
    if (!probeIds) {
      this.#report = report;
    } else {
      this.#report = mergeReports(this.#report, report, this.#probes.size);
    }
    return report;
  }

  inspect(probeId: string): AssuranceProbeResult {
    const result = this.#report?.results.find(
      (item) => item.probeId === probeId,
    );
    if (!result) {
      throw new AssuranceInputError(
        `probe '${probeId}' has no completed run to inspect.`,
      );
    }
    return result;
  }

  async minimize(probeId: string): Promise<MinimizationResult> {
    const original = this.#probes.get(probeId);
    if (!original) throw new AssuranceInputError(`unknown probe '${probeId}'.`);
    const originalResult = this.inspect(probeId);
    if (
      originalResult.classification !== "local-counterexample" &&
      originalResult.classification !== "candidate-signal"
    ) {
      throw new AssuranceInputError(
        `probe '${probeId}' has no counterexample to minimize.`,
      );
    }

    const operation = original.mutation.operation;
    const data = "data" in operation ? operation.data : undefined;
    if (
      original.mutation.dimension !== "payload" ||
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      return {
        probeId,
        changed: false,
        removedPayloadFields: [],
        probe: original,
        result: originalResult,
      };
    }

    let kept = { ...(data as Record<string, unknown>) };
    const controlData =
      "data" in original.control &&
      original.control.data &&
      typeof original.control.data === "object" &&
      !Array.isArray(original.control.data)
        ? (original.control.data as Record<string, unknown>)
        : {};
    const retainsPayloadDelta = (candidate: Record<string, unknown>) =>
      Object.keys(candidate).some(
        (field) =>
          stableValue(candidate[field]) !== stableValue(controlData[field]),
      );
    if (!retainsPayloadDelta(kept)) {
      return {
        probeId,
        changed: false,
        removedPayloadFields: [],
        probe: original,
        result: originalResult,
      };
    }
    this.#assertRunBudget(Object.keys(kept).length);
    const removedPayloadFields: string[] = [];
    let bestProbe = original;
    let bestResult = originalResult;
    for (const field of Object.keys(kept)) {
      if (Object.keys(kept).length === 1) break;
      const candidateData = { ...kept };
      delete candidateData[field];
      if (!retainsPayloadDelta(candidateData)) continue;
      const candidate: AssuranceProbe = {
        ...original,
        id: `${original.id}--min-${field}`,
        mutation: {
          ...original.mutation,
          operation: { ...operation, data: candidateData } as typeof operation,
        },
      };
      const report = await runAuthorizationCampaign({
        ...this.spec([probeId]),
        probes: [candidate],
      });
      this.#runs++;
      const result = report.results[0]!;
      if (result.classification === originalResult.classification) {
        kept = candidateData;
        removedPayloadFields.push(field);
        bestProbe = { ...candidate, id: original.id };
        bestResult = { ...result, probeId: original.id };
      }
    }
    if (removedPayloadFields.length > 0) {
      this.#probes.set(probeId, bestProbe);
      this.#report = replaceResult(this.#report!, bestResult);
    }
    return {
      probeId,
      changed: removedPayloadFields.length > 0,
      removedPayloadFields,
      probe: bestProbe,
      result: bestResult,
    };
  }

  exportSecurityCases(
    options: { includeCandidates?: boolean } = {},
  ): SecurityCase[] {
    if (!this.#report)
      throw new AssuranceInputError("campaign has not been run.");
    return this.#report.results
      .filter(
        (result) =>
          result.classification === "local-counterexample" ||
          (options.includeCandidates &&
            result.classification === "candidate-signal"),
      )
      .map((result) => ({
        schema: "pyric.assurance.case.v1" as const,
        id: result.probeId,
        campaignId: this.id,
        actorId: result.actorEvidence.actorId,
        invariant: result.invariant,
        control: result.control.operation,
        mutation: result.mutationSpec,
        expect: result.invariant.expected,
        qualification: result.qualification,
      }));
  }

  async verifyRules(options: {
    rules: LocalFirebaseTarget["rules"];
    includeCandidates?: boolean;
    id?: string;
  }): Promise<AuthorizationCampaignReport> {
    if (!options.rules || Object.keys(options.rules).length === 0) {
      throw new AssuranceInputError(
        "candidate rules must include at least one service.",
      );
    }
    const cases = this.exportSecurityCases({
      includeCandidates: options.includeCandidates,
    });
    if (cases.length === 0) {
      throw new AssuranceInputError(
        "campaign has no qualified regression cases to verify.",
      );
    }
    this.#assertRunBudget(cases.length);
    const report = await runSecurityCases({
      campaignId:
        options.id ??
        `${this.id}-verification-${this.#verifications.length + 1}`,
      target: {
        ...this.target,
        rules: { ...this.target.rules, ...options.rules },
      },
      actors: [...this.#actors.values()],
      cases,
    });
    this.#runs += cases.length;
    this.#verifications.push(report);
    return report;
  }

  export(): CampaignExport {
    return {
      schema: "pyric.assurance.export.v1",
      campaign: this.spec(),
      ...(this.context ? { context: this.context } : {}),
      observations: [...this.#observations.values()],
      ...(this.#report ? { report: this.#report } : {}),
      cases: this.#report ? this.exportSecurityCases() : [],
      ...(this.#verifications.length > 0
        ? { verifications: [...this.#verifications] }
        : {}),
    };
  }

  visualization(): AssuranceVisualizationSnapshot {
    return {
      schema: "pyric.assurance.visualization.v1",
      campaignId: this.id,
      ...(this.context ? { context: this.context } : {}),
      observations: [...this.#observations.values()],
      probes: [...this.#probes.values()],
      ...(this.#report ? { report: this.#report } : {}),
      ...(this.#verifications.length > 0
        ? { verifications: [...this.#verifications] }
        : {}),
    };
  }

  get report(): AuthorizationCampaignReport | undefined {
    return this.#report;
  }

  get observations(): AssuranceObservation[] {
    return [...this.#observations.values()];
  }

  #addUnique<T extends { id: string }>(
    map: Map<string, T>,
    value: T,
    label: string,
  ): void {
    if (!value.id.trim())
      throw new AssuranceInputError(`${label} id is required.`);
    if (map.has(value.id))
      throw new AssuranceInputError(`duplicate ${label} id '${value.id}'.`);
    map.set(value.id, value);
  }

  #assertRunBudget(count: number): void {
    if (this.#runs + count > this.maxRuns) {
      throw new AssuranceInputError(
        `campaign run budget exceeded: ${this.#runs + count}/${this.maxRuns} probes.`,
      );
    }
  }
}

function stableValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
    .join(",")}}`;
}

function mergeReports(
  existing: AuthorizationCampaignReport | undefined,
  incoming: AuthorizationCampaignReport,
  totalProbes: number,
): AuthorizationCampaignReport {
  if (!existing) return incoming;
  const byId = new Map(
    existing.results.map((result) => [result.probeId, result]),
  );
  for (const result of incoming.results) byId.set(result.probeId, result);
  const results = [...byId.values()];
  return {
    ...incoming,
    results,
    summary: summarizeResults(results, totalProbes),
  };
}

function replaceResult(
  report: AuthorizationCampaignReport,
  replacement: AssuranceProbeResult,
): AuthorizationCampaignReport {
  const results = report.results.map((result) =>
    result.probeId === replacement.probeId ? replacement : result,
  );
  return {
    ...report,
    results,
    summary: summarizeResults(results, results.length),
  };
}

function summarizeResults(
  results: AssuranceProbeResult[],
  totalProbes: number,
): AuthorizationCampaignReport["summary"] {
  return {
    probes: totalProbes,
    controlsPassed: results.filter(
      (result) => result.control.decision === "ALLOW",
    ).length,
    localCounterexamples: results.filter(
      (result) => result.classification === "local-counterexample",
    ).length,
    candidateSignals: results.filter(
      (result) => result.classification === "candidate-signal",
    ).length,
    noCounterexamples: results.filter(
      (result) => result.classification === "no-counterexample",
    ).length,
    engineGaps: results.filter(
      (result) => result.classification === "engine-gap",
    ).length,
    invalidProbes: results.filter(
      (result) => result.classification === "invalid-probe",
    ).length,
  };
}

export function createAuthorizationCampaign(
  options: CreateAuthorizationCampaignOptions,
): AuthorizationCampaign {
  return new AuthorizationCampaign(options);
}
