import type { LocalSandbox } from "pyric/sandbox";
import type { ToolHandler } from "pyric/sandbox/internal";
import type { AssuranceAttachmentProvider } from "./attachment.js";
import { publishAssuranceVisualization } from "./browser.js";
import {
  AuthorizationCampaign,
  createAuthorizationCampaign,
} from "./campaign.js";
import { createDeriveAssuranceTool } from "./derive-tool.js";
import {
  actorSchema,
  campaignParameters,
  invariantSchema,
  mutationSchema,
  observationSchema,
  probeSchema,
  redactCampaignExport,
  resultError,
  rulesSchema,
  targetSchema,
} from "./tools-schemas.js";
import {
  AssuranceInputError,
  type AssuranceActor,
  type AssuranceObservation,
  type AssuranceProbe,
  type AssuranceVisualizationSnapshot,
  type LocalFirebaseTarget,
  type MutationCandidate,
  type SecurityInvariant,
} from "./types.js";

export class AssuranceCampaignStore {
  #campaigns = new Map<string, AuthorizationCampaign>();
  #listeners = new Set<(campaign: AssuranceVisualizationSnapshot) => void>();

  create(campaign: AuthorizationCampaign): void {
    if (this.#campaigns.has(campaign.id)) {
      throw new AssuranceInputError(
        `campaign '${campaign.id}' already exists.`,
      );
    }
    this.#campaigns.set(campaign.id, campaign);
  }

  replace(campaign: AuthorizationCampaign): void {
    this.#campaigns.set(campaign.id, campaign);
  }

  get(id: string): AuthorizationCampaign {
    const campaign = this.#campaigns.get(id);
    if (!campaign) throw new AssuranceInputError(`unknown campaign '${id}'.`);
    return campaign;
  }

  publish(campaign: AuthorizationCampaign): void {
    const snapshot = campaign.visualization();
    for (const listener of this.#listeners) listener(snapshot);
    publishAssuranceVisualization(snapshot);
  }

  subscribe(
    listener: (campaign: AssuranceVisualizationSnapshot) => void,
  ): () => void {
    this.#listeners.add(listener);
    for (const campaign of this.#campaigns.values()) {
      listener(campaign.visualization());
    }
    return () => this.#listeners.delete(listener);
  }
}

export const defaultAssuranceCampaignStore = new AssuranceCampaignStore();

export interface AssuranceToolDeps {
  store?: AssuranceCampaignStore;
  onCampaignUpdate?: (campaign: AssuranceVisualizationSnapshot) => void;
  attachmentProvider?: AssuranceAttachmentProvider;
  sandbox?: LocalSandbox;
  projectDir?: string;
  fetchImpl?: typeof fetch;
}

let generatedCampaignId = 0;

function configuredServices(
  rules: LocalFirebaseTarget["rules"],
): Array<"firestore" | "rtdb" | "storage"> {
  const services: Array<"firestore" | "rtdb" | "storage"> = [];
  if (rules.firestore !== undefined) services.push("firestore");
  if (
    rules.rtdb !== undefined ||
    (rules.rtdbInstances !== undefined &&
      Object.keys(rules.rtdbInstances).length > 0)
  ) {
    services.push("rtdb");
  }
  if (
    rules.storage !== undefined ||
    (rules.storageBuckets !== undefined &&
      Object.keys(rules.storageBuckets).length > 0)
  ) {
    services.push("storage");
  }
  return services;
}

export function createAssuranceTools(
  deps: AssuranceToolDeps = {},
): ToolHandler[] {
  const store = deps.store ?? defaultAssuranceCampaignStore;
  if (deps.onCampaignUpdate) store.subscribe(deps.onCampaignUpdate);
  return [
    {
      name: "firebase_assurance_attach",
      description:
        "Attach read-only to the same-origin Pyric sandbox behind a loopback Studio URL, clone its explicit Firestore/RTDB/Auth state, and start an isolated authorization campaign. The live sandbox is never probed or mutated.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          campaignId: { type: "string", minLength: 1 },
          maxRuns: { type: "integer", minimum: 1 },
        },
        required: ["url"],
      },
      async execute(args) {
        const input = args as {
          url: string;
          campaignId?: string;
          maxRuns?: number;
        };
        try {
          if (!deps.attachmentProvider) {
            throw new AssuranceInputError(
              "localhost attachment is unavailable in this runtime. Provide an attachmentProvider or use firebase_assurance_start with an explicit target.",
            );
          }
          const attached = await deps.attachmentProvider({ url: input.url });
          const campaignId =
            input.campaignId ?? `assurance-${++generatedCampaignId}`;
          const safety: { network: "forbid"; maxRuns?: number } = {
            network: "forbid",
          };
          if (input.maxRuns !== undefined) safety.maxRuns = input.maxRuns;
          const campaign = createAuthorizationCampaign({
            id: campaignId,
            target: attached.target,
            context: {
              attachment: {
                source: attached.source,
                inventory: attached.inventory,
                coverageGaps: attached.coverageGaps,
              },
            },
            safety,
          });
          store.create(campaign);
          store.publish(campaign);
          const services = configuredServices(attached.target.rules);
          const visualizationUrl = new URL(attached.source.studioUrl);
          visualizationUrl.searchParams.set("campaign", campaignId);
          return {
            ok: true,
            summary: `Attached read-only to '${attached.source.origin}' and cloned ${services.join(", ") || "no rules services"} into local campaign '${campaignId}'`,
            data: {
              campaignId,
              localOnly: true,
              attachment: { network: "loopback-read-only" },
              execution: { network: "forbid", engine: "pyric-local-sandboxes" },
              source: attached.source,
              inventory: attached.inventory,
              services,
              coverageGaps: attached.coverageGaps,
              suggestedActors: (attached.target.state.auth?.users ?? []).map(
                (user) => ({
                  id: `candidate-${user.uid}`,
                  acquisition: { kind: "synthetic" as const, uid: user.uid },
                  reachability: "candidate-only" as const,
                  reason:
                    "Auth inventory proves this identity exists, not that an attacker can acquire it. Use fixture-user only after the app owner confirms the test account is obtainable.",
                }),
              ),
              visualization: {
                view: "assurance",
                url: visualizationUrl.toString(),
              },
              nextActions: [
                "Map reachable actors and known-good operations from the cloned state.",
                "Define explicit security invariants before interpreting permissive behavior.",
              ],
            },
          };
        } catch (error) {
          return resultError(error);
        }
      },
    },
    createDeriveAssuranceTool(store, deps),
    {
      name: "firebase_assurance_start",
      description:
        "Start a defensive authorization campaign against Pyric local sandboxes only. Requires network=forbid and never contacts Firebase, an emulator, or a real database.",
      parameters: {
        type: "object",
        properties: {
          campaignId: { type: "string", minLength: 1 },
          target: targetSchema,
          maxRuns: { type: "integer", minimum: 1 },
        },
        required: ["target"],
      },
      async execute(args) {
        const input = args as {
          campaignId?: string;
          target: LocalFirebaseTarget;
          maxRuns?: number;
        };
        try {
          const campaignId =
            input.campaignId ?? `assurance-${++generatedCampaignId}`;
          const safety: { network: "forbid"; maxRuns?: number } = {
            network: "forbid",
          };
          if (input.maxRuns !== undefined) safety.maxRuns = input.maxRuns;
          const campaign = createAuthorizationCampaign({
            id: campaignId,
            target: input.target,
            safety,
          });
          store.create(campaign);
          store.publish(campaign);
          const services = configuredServices(input.target.rules);
          return {
            ok: true,
            summary: `Started local-only campaign '${campaignId}' for ${services.join(", ") || "no configured services"}`,
            data: {
              campaignId,
              localOnly: true,
              network: "forbid",
              services,
              nextActions: [
                "Map reachable actors and known-good operations.",
                "Define explicit security invariants.",
              ],
            },
          };
        } catch (error) {
          return resultError(error);
        }
      },
    },
    {
      name: "firebase_assurance_map",
      description:
        "Add reachable actors, known-good observations, and optional authored probes to a local assurance campaign.",
      parameters: campaignParameters({
        actors: { type: "array", items: actorSchema },
        observations: { type: "array", items: observationSchema },
        probes: { type: "array", items: probeSchema },
      }),
      async execute(args) {
        const input = args as {
          campaignId: string;
          actors?: AssuranceActor[];
          observations?: AssuranceObservation[];
          probes?: AssuranceProbe[];
        };
        try {
          const campaign = store.get(input.campaignId);
          const counts = campaign.map({
            actors: input.actors,
            observations: input.observations,
            probes: input.probes,
          });
          store.publish(campaign);
          return {
            ok: true,
            summary: `Mapped ${counts.actors} actor(s), ${counts.observations} observation(s), and ${counts.probes} probe(s)`,
            data: {
              actors: counts.actors,
              observations: counts.observations,
              probes: counts.probes,
              nextActions: [
                "Define the intended boundary for each negative probe.",
              ],
            },
          };
        } catch (error) {
          return resultError(error);
        }
      },
    },
    {
      name: "firebase_assurance_define",
      description:
        "Add explicit authorization invariants. Permissive behavior is not interpreted without one of these expectations.",
      parameters: {
        ...campaignParameters({
          invariants: { type: "array", minItems: 1, items: invariantSchema },
        }),
        required: ["campaignId", "invariants"],
      },
      async execute(args) {
        const input = args as {
          campaignId: string;
          invariants: SecurityInvariant[];
        };
        try {
          const campaign = store.get(input.campaignId);
          for (const invariant of input.invariants ?? []) {
            campaign.addInvariant(invariant);
          }
          store.publish(campaign);
          const count = campaign.spec().invariants.length;
          return {
            ok: true,
            summary: `Campaign now has ${count} explicit invariant(s)`,
            data: {
              invariants: count,
              nextActions: [
                "Propose one-dimension mutations from known-good operations.",
              ],
            },
          };
        } catch (error) {
          return resultError(error);
        }
      },
    },
    {
      name: "firebase_assurance_propose",
      description:
        "Turn a known-good observation into bounded probes by changing exactly one mechanically checked path, query, payload, or operation dimension.",
      parameters: {
        ...campaignParameters({
          observationId: { type: "string", minLength: 1 },
          invariantId: { type: "string", minLength: 1 },
          mutations: { type: "array", minItems: 1, items: mutationSchema },
        }),
        required: ["campaignId", "observationId", "invariantId", "mutations"],
      },
      async execute(args) {
        const input = args as {
          campaignId: string;
          observationId: string;
          invariantId: string;
          mutations: MutationCandidate[];
        };
        try {
          const campaign = store.get(input.campaignId);
          const probes = campaign.propose(input);
          store.publish(campaign);
          return {
            ok: true,
            summary: `Proposed ${probes.length} probe(s)`,
            data: {
              probes,
              nextActions: [
                "Run the control and selected mutations in isolated local sandboxes.",
              ],
            },
          };
        } catch (error) {
          return resultError(error);
        }
      },
    },
    {
      name: "firebase_assurance_run",
      description:
        "Run selected controls and mutations against fresh Pyric local sandboxes, then classify expected/observed behavior with evaluator fidelity gates.",
      parameters: campaignParameters({
        probeIds: { type: "array", items: { type: "string" } },
      }),
      async execute(args) {
        const input = args as { campaignId: string; probeIds?: string[] };
        try {
          const campaign = store.get(input.campaignId);
          const report = await campaign.run(input.probeIds);
          store.publish(campaign);
          let nextActions = [
            "Inspect engine and coverage gaps before expanding mutations.",
          ];
          if (report.summary.localCounterexamples > 0) {
            nextActions = [
              "Inspect and minimize local counterexamples.",
              "Test a candidate rules change with exported cases.",
            ];
          }
          return {
            ok: true,
            summary: `Ran ${report.summary.probes} probe(s): ${report.summary.localCounterexamples} local counterexample(s), ${report.summary.engineGaps} engine gap(s)`,
            data: { ...report, nextActions },
          };
        } catch (error) {
          return resultError(error);
        }
      },
    },
    {
      name: "firebase_assurance_inspect",
      description:
        "Inspect one completed probe with actor evidence, exact operations, state impact, event evidence, and engine qualification.",
      parameters: {
        ...campaignParameters({ probeId: { type: "string", minLength: 1 } }),
        required: ["campaignId", "probeId"],
      },
      async execute(args) {
        const input = args as { campaignId: string; probeId: string };
        try {
          const result = store.get(input.campaignId).inspect(input.probeId);
          let nextActions = ["Review its qualification and evidence."];
          if (result.classification === "local-counterexample") {
            nextActions = [
              "Minimize this counterexample.",
              "Open its rule decision in Studio.",
            ];
          }
          return {
            ok: true,
            summary: `${input.probeId}: ${result.classification}`,
            data: {
              result,
              visualization: {
                view: "assurance",
                campaignId: input.campaignId,
                probeId: input.probeId,
              },
              nextActions,
            },
          };
        } catch (error) {
          return resultError(error);
        }
      },
    },
    {
      name: "firebase_assurance_minimize",
      description:
        "Minimize a demonstrated local counterexample by removing payload fields while preserving its qualified classification.",
      parameters: {
        ...campaignParameters({ probeId: { type: "string", minLength: 1 } }),
        required: ["campaignId", "probeId"],
      },
      async execute(args) {
        const input = args as { campaignId: string; probeId: string };
        try {
          const campaign = store.get(input.campaignId);
          const result = await campaign.minimize(input.probeId);
          store.publish(campaign);
          let summary = `'${input.probeId}' is already minimal for the v1 payload reducer`;
          if (result.changed) {
            summary = `Minimized '${input.probeId}' by removing ${result.removedPayloadFields.length} field(s)`;
          }
          return {
            ok: true,
            summary,
            data: {
              ...result,
              nextActions: [
                "Export this explicit expectation as a regression case.",
              ],
            },
          };
        } catch (error) {
          return resultError(error);
        }
      },
    },
    {
      name: "firebase_assurance_verify",
      description:
        "Verify candidate local rules against the campaign regression cases while retaining private actor credentials inside the campaign. Preserves known-good controls and requires negative cases to be denied in fresh Pyric sandboxes.",
      parameters: {
        ...campaignParameters({
          rules: rulesSchema,
          includeCandidates: { type: "boolean" },
          verificationId: { type: "string" },
        }),
        required: ["campaignId", "rules"],
      },
      async execute(args) {
        const input = args as {
          campaignId: string;
          rules: LocalFirebaseTarget["rules"];
          includeCandidates?: boolean;
          verificationId?: string;
        };
        try {
          const campaign = store.get(input.campaignId);
          const verifyOptions: {
            rules: LocalFirebaseTarget["rules"];
            includeCandidates?: boolean;
            id?: string;
          } = { rules: input.rules };
          if (input.includeCandidates !== undefined) {
            verifyOptions.includeCandidates = input.includeCandidates;
          }
          if (input.verificationId) {
            verifyOptions.id = input.verificationId;
          }
          const report = await campaign.verifyRules(verifyOptions);
          store.publish(campaign);
          const passed =
            report.summary.controlsPassed === report.summary.probes &&
            report.summary.noCounterexamples === report.summary.probes &&
            report.summary.localCounterexamples === 0 &&
            report.summary.engineGaps === 0 &&
            report.summary.invalidProbes === 0;
          let summary = `Candidate rules did not fully verify: ${report.summary.controlsPassed}/${report.summary.probes} controls passed and ${report.summary.noCounterexamples}/${report.summary.probes} negative cases were denied`;
          let nextActions = [
            "Inspect verification results before changing or reporting the candidate rules.",
          ];
          if (passed) {
            summary = `Candidate rules preserved ${report.summary.controlsPassed} control(s) and denied ${report.summary.noCounterexamples} negative case(s)`;
            nextActions = [
              "Export the campaign and verified regression cases.",
            ];
          }
          return {
            ok: true,
            summary,
            data: {
              ...report,
              verified: passed,
              visualization: {
                view: "assurance",
                campaignId: input.campaignId,
                verificationId: report.campaignId,
              },
              nextActions,
            },
          };
        } catch (error) {
          return resultError(error);
        }
      },
    },
    {
      name: "firebase_assurance_export",
      description:
        "Export the serializable local campaign, observations, qualified report, and explicit regression cases.",
      parameters: campaignParameters(),
      async execute(args) {
        const input = args as { campaignId: string };
        try {
          const bundle = redactCampaignExport(
            store.get(input.campaignId).export(),
          );
          return {
            ok: true,
            summary: `Exported campaign '${input.campaignId}' with ${bundle.cases.length} regression case(s)`,
            data: bundle,
          };
        } catch (error) {
          return resultError(error);
        }
      },
    },
  ];
}
