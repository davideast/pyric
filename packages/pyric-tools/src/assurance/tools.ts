import type { ToolHandler } from "@inbrowser/agent";
import {
  AuthorizationCampaign,
  createAuthorizationCampaign,
} from "./campaign.js";
import { listAssuranceCapabilities } from "./capabilities.js";
import { publishAssuranceVisualization } from "./browser.js";
import type { AssuranceAttachmentProvider } from "./attachment.js";
import {
  AssuranceInputError,
  type AssuranceActor,
  type CampaignExport,
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
    for (const campaign of this.#campaigns.values())
      listener(campaign.visualization());
    return () => this.#listeners.delete(listener);
  }
}

export const defaultAssuranceCampaignStore = new AssuranceCampaignStore();

export interface AssuranceToolDeps {
  store?: AssuranceCampaignStore;
  onCampaignUpdate?: (campaign: AssuranceVisualizationSnapshot) => void;
  attachmentProvider?: AssuranceAttachmentProvider;
}

let generatedCampaignId = 0;

const jsonRecordSchema = {
  type: "object",
  additionalProperties: true,
};

const firestoreOperationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    service: { const: "firestore" },
    method: {
      enum: ["get", "list", "create", "set", "merge", "update", "delete"],
    },
    path: { type: "string", minLength: 1 },
    data: jsonRecordSchema,
    query: jsonRecordSchema,
  },
  required: ["service", "method", "path"],
};

const rtdbOperationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    service: { const: "rtdb" },
    method: { enum: ["get", "set", "update", "remove"] },
    path: { type: "string", minLength: 1 },
    data: {},
    query: jsonRecordSchema,
  },
  required: ["service", "method", "path"],
};

const storageOperationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    service: { const: "storage" },
    method: { enum: ["get", "list", "upload", "updateMetadata", "delete"] },
    path: { type: "string", minLength: 1 },
    dataBase64: { type: "string" },
    contentType: { type: "string" },
    customMetadata: {
      type: "object",
      additionalProperties: { type: "string" },
    },
  },
  required: ["service", "method", "path"],
};

const operationSchema = {
  oneOf: [
    firestoreOperationSchema,
    rtdbOperationSchema,
    storageOperationSchema,
  ],
};

const actorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    acquisition: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: { kind: { const: "anonymous-request" } },
          required: ["kind"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { kind: { const: "anonymous-account" } },
          required: ["kind"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "password" },
            email: { type: "string", minLength: 1 },
            password: { type: "string", minLength: 1 },
          },
          required: ["kind", "email", "password"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "fixture-user" },
            uid: { type: "string", minLength: 1 },
          },
          required: ["kind", "uid"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "synthetic" },
            uid: { type: "string", minLength: 1 },
            token: jsonRecordSchema,
          },
          required: ["kind", "uid"],
        },
      ],
    },
  },
  required: ["id", "acquisition"],
};

const invariantSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    statement: { type: "string", minLength: 1 },
    service: { enum: ["firestore", "rtdb", "storage", "cross-service"] },
    expected: { enum: ["ALLOW", "DENY"] },
    source: {
      enum: ["declared", "authored-test", "captured", "derived", "agent"],
    },
    confidence: { enum: ["authoritative", "strong", "tentative"] },
  },
  required: ["id", "statement", "service", "expected", "source", "confidence"],
};

const observationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    actorId: { type: "string", minLength: 1 },
    operation: operationSchema,
    result: { const: "ALLOW" },
    source: { enum: ["captured", "authored", "discovered"] },
    description: { type: "string" },
  },
  required: ["id", "actorId", "operation", "result", "source"],
};

const mutationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    dimension: { enum: ["path", "query", "payload", "operation"] },
    description: { type: "string", minLength: 1 },
    operation: operationSchema,
  },
  required: ["dimension", "description", "operation"],
};

const probeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    actorId: { type: "string", minLength: 1 },
    invariantId: { type: "string", minLength: 1 },
    control: operationSchema,
    mutation: mutationSchema,
    requires: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { enum: ["construct", "registry-row"] },
          id: { type: "string", minLength: 1 },
        },
        required: ["kind", "id"],
      },
    },
    // Deprecated: capability ids, superseded by `requires`. Still accepted.
    requirements: { type: "array", items: { type: "string" } },
  },
  required: ["id", "actorId", "invariantId", "control", "mutation"],
};

const rulesSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    firestore: { type: "string" },
    rtdb: {
      type: "object",
      additionalProperties: false,
      properties: { rules: jsonRecordSchema },
      required: ["rules"],
    },
    storage: { type: "string" },
  },
};

const targetSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema: { const: "pyric.assurance.target.v1" },
    network: { const: "forbid" },
    rules: rulesSchema,
    state: {
      type: "object",
      additionalProperties: false,
      properties: {
        firestore: jsonRecordSchema,
        rtdb: {},
        storage: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string", minLength: 1 },
              dataBase64: { type: "string" },
              contentType: { type: "string" },
              customMetadata: {
                type: "object",
                additionalProperties: { type: "string" },
              },
            },
            required: ["path", "dataBase64"],
          },
        },
        auth: {
          type: "object",
          additionalProperties: false,
          properties: {
            users: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  uid: { type: "string", minLength: 1 },
                  email: {
                    oneOf: [{ type: "string" }, { type: "null" }],
                  },
                  password: { type: "string" },
                  emailVerified: { type: "boolean" },
                  disabled: { type: "boolean" },
                  customClaims: jsonRecordSchema,
                },
                required: ["uid"],
              },
            },
          },
          required: ["users"],
        },
      },
    },
  },
  required: ["schema", "network", "rules", "state"],
};

function resultError(error: unknown): {
  ok: false;
  summary: string;
  data?: { code: string };
} {
  return {
    ok: false,
    summary: error instanceof Error ? error.message : String(error),
    ...(error instanceof AssuranceInputError
      ? { data: { code: error.code } }
      : {}),
  };
}

function campaignParameters(
  extra: Record<string, unknown> = {},
): ToolHandler["parameters"] {
  return {
    type: "object",
    properties: {
      campaignId: { type: "string", minLength: 1 },
      ...extra,
    },
    required: ["campaignId"],
  };
}

function redactCampaignExport(bundle: CampaignExport) {
  const auth = bundle.campaign.target.state.auth;
  const actors = bundle.campaign.actors.map((actor) =>
    actor.acquisition.kind === "password"
      ? {
          ...actor,
          acquisition: { ...actor.acquisition, password: "[REDACTED]" },
        }
      : actor,
  );
  const target = {
    ...bundle.campaign.target,
    state: {
      ...bundle.campaign.target.state,
      ...(auth
        ? {
            auth: {
              users: auth.users.map((user) => {
                const { password: _password, ...safe } = user;
                return safe;
              }),
            },
          }
        : {}),
    },
  };
  return {
    ...bundle,
    campaign: { ...bundle.campaign, target, actors },
    redactions: [
      "campaign.target.state.auth.users[].password",
      "campaign.actors[].acquisition.password",
    ],
  };
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
              "localhost attachment is unavailable in this runtime. Connect through the running Pyric instance MCP endpoint or use firebase_assurance_start with an explicit target.",
            );
          }
          const attached = await deps.attachmentProvider({ url: input.url });
          const campaignId =
            input.campaignId ?? `assurance-${++generatedCampaignId}`;
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
            safety: {
              network: "forbid",
              ...(input.maxRuns !== undefined
                ? { maxRuns: input.maxRuns }
                : {}),
            },
          });
          store.create(campaign);
          store.publish(campaign);
          const services = (["firestore", "rtdb", "storage"] as const).filter(
            (service) => attached.target.rules[service] !== undefined,
          );
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
              capabilities: listAssuranceCapabilities([...services, "auth"]),
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
          const campaign = createAuthorizationCampaign({
            id: campaignId,
            target: input.target,
            safety: {
              network: "forbid",
              ...(input.maxRuns !== undefined
                ? { maxRuns: input.maxRuns }
                : {}),
            },
          });
          store.create(campaign);
          store.publish(campaign);
          const services = (["firestore", "rtdb", "storage"] as const).filter(
            (service) => input.target.rules[service] !== undefined,
          );
          return {
            ok: true,
            summary: `Started local-only campaign '${campaignId}' for ${services.join(", ") || "no configured services"}`,
            data: {
              campaignId,
              localOnly: true,
              network: "forbid",
              services,
              capabilities: listAssuranceCapabilities([...services, "auth"]),
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
          for (const actor of input.actors ?? []) campaign.addActor(actor);
          for (const observation of input.observations ?? [])
            campaign.addObservation(observation);
          for (const probe of input.probes ?? []) campaign.addProbe(probe);
          store.publish(campaign);
          const spec = campaign.spec();
          return {
            ok: true,
            summary: `Mapped ${spec.actors.length} actor(s), ${campaign.observations.length} observation(s), and ${spec.probes.length} probe(s)`,
            data: {
              actors: spec.actors.length,
              observations: campaign.observations.length,
              probes: spec.probes.length,
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
          for (const invariant of input.invariants ?? [])
            campaign.addInvariant(invariant);
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
          return {
            ok: true,
            summary: `Ran ${report.summary.probes} probe(s): ${report.summary.localCounterexamples} local counterexample(s), ${report.summary.engineGaps} engine gap(s)`,
            data: {
              ...report,
              nextActions: report.summary.localCounterexamples
                ? [
                    "Inspect and minimize local counterexamples.",
                    "Test a candidate rules change with exported cases.",
                  ]
                : [
                    "Inspect engine and coverage gaps before expanding mutations.",
                  ],
            },
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
              nextActions:
                result.classification === "local-counterexample"
                  ? [
                      "Minimize this counterexample.",
                      "Open its rule decision in Studio.",
                    ]
                  : ["Review its qualification and evidence."],
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
          return {
            ok: true,
            summary: result.changed
              ? `Minimized '${input.probeId}' by removing ${result.removedPayloadFields.length} field(s)`
              : `'${input.probeId}' is already minimal for the v1 payload reducer`,
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
          const report = await campaign.verifyRules({
            rules: input.rules,
            ...(input.includeCandidates !== undefined
              ? { includeCandidates: input.includeCandidates }
              : {}),
            ...(input.verificationId ? { id: input.verificationId } : {}),
          });
          store.publish(campaign);
          const passed =
            report.summary.controlsPassed === report.summary.probes &&
            report.summary.noCounterexamples === report.summary.probes &&
            report.summary.localCounterexamples === 0 &&
            report.summary.engineGaps === 0 &&
            report.summary.invalidProbes === 0;
          return {
            ok: true,
            summary: passed
              ? `Candidate rules preserved ${report.summary.controlsPassed} control(s) and denied ${report.summary.noCounterexamples} negative case(s)`
              : `Candidate rules did not fully verify: ${report.summary.controlsPassed}/${report.summary.probes} controls passed and ${report.summary.noCounterexamples}/${report.summary.probes} negative cases were denied`,
            data: {
              ...report,
              verified: passed,
              visualization: {
                view: "assurance",
                campaignId: input.campaignId,
                verificationId: report.campaignId,
              },
              nextActions: passed
                ? ["Export the campaign and verified regression cases."]
                : [
                    "Inspect verification results before changing or reporting the candidate rules.",
                  ],
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
