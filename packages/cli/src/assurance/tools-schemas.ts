import type { ToolHandler } from "pyric/sandbox/internal";
import {
  AssuranceInputError,
  type AssuranceActor,
  type CampaignExport,
  type LocalFirebaseTarget,
} from "./types.js";

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
    instance: { type: "string", minLength: 1 },
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

export const actorSchema = {
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

export const invariantSchema = {
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

export const observationSchema = {
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

export const mutationSchema = {
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

export const probeSchema = {
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
  },
  required: ["id", "actorId", "invariantId", "control", "mutation"],
};

export const rulesSchema = {
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
    rtdbInstances: jsonRecordSchema,
    storage: { type: "string" },
  },
};

export const targetSchema = {
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
        rtdbInstances: jsonRecordSchema,
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
                  displayName: { type: "string" },
                  photoUrl: { type: "string" },
                  phoneNumber: { type: "string" },
                  tenantId: { type: "string" },
                  providerId: { type: "string" },
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

export function resultError(error: unknown): {
  ok: false;
  summary: string;
  data?: { code: string };
} {
  let summary = String(error);
  if (error instanceof Error) {
    summary = error.message;
  }
  const failure: {
    ok: false;
    summary: string;
    data?: { code: string };
  } = { ok: false, summary };
  if (error instanceof AssuranceInputError) {
    failure.data = { code: error.code };
  }
  return failure;
}

export function campaignParameters(
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

export function redactCampaignExport(bundle: CampaignExport): CampaignExport & {
  redactions: string[];
} {
  const auth = bundle.campaign.target.state.auth;
  const actors = bundle.campaign.actors.map((actor): AssuranceActor => {
    if (actor.acquisition.kind !== "password") return actor;
    return {
      ...actor,
      acquisition: { ...actor.acquisition, password: "[REDACTED]" },
    };
  });
  const nextState: LocalFirebaseTarget["state"] = {
    ...bundle.campaign.target.state,
  };
  if (auth) {
    nextState.auth = {
      users: auth.users.map((user) => {
        const { password: _password, ...safe } = user;
        return safe;
      }),
    };
  }
  const target: LocalFirebaseTarget = {
    ...bundle.campaign.target,
    state: nextState,
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
