/**
 * `firebase_assurance_derive` MCP tool handler factory.
 */
import type { LocalSandbox } from "pyric/sandbox";
import type { ToolHandler } from "pyric/sandbox/internal";
import type { AssuranceAttachmentProvider } from "./attachment.js";
import { deriveAssurance, type DeriveAssuranceInput } from "./derive.js";
import { resultError } from "./tools-schemas.js";
import type { AssuranceCampaignStore } from "./tools.js";

export interface DeriveToolRuntimeDeps {
  readonly sandbox?: LocalSandbox;
  readonly attachmentProvider?: AssuranceAttachmentProvider;
  readonly projectDir?: string;
  readonly fetchImpl?: typeof fetch;
}

export const deriveToolParameters: ToolHandler["parameters"] = {
  type: "object",
  properties: {
    root: { type: "string", minLength: 1 },
    url: { type: "string", format: "uri" },
    campaignId: { type: "string", minLength: 1 },
    includeStaticChecks: { type: "boolean" },
    includeHeuristic: { type: "boolean" },
  },
};

export function createDeriveAssuranceTool(
  store: AssuranceCampaignStore,
  deps: DeriveToolRuntimeDeps = {},
): ToolHandler {
  return {
    name: "firebase_assurance_derive",
    description:
      "Derive tri-source assurance diagnostics (static proofs, coverage gaps, and sandbox-reproduced counterexamples) from project code, security rules, and optional live sandbox state, registering a local campaign.",
    parameters: deriveToolParameters,
    async execute(args) {
      const raw = (args ?? {}) as {
        root?: string;
        url?: string;
        campaignId?: string;
        includeStaticChecks?: boolean;
        includeHeuristic?: boolean;
      };
      try {
        const input: {
          root?: string;
          url?: string;
          campaignId?: string;
          includeStaticChecks?: boolean;
          includeHeuristic?: boolean;
        } = {};
        if (raw.root !== undefined) input.root = raw.root;
        if (raw.url !== undefined) input.url = raw.url;
        if (raw.campaignId !== undefined) input.campaignId = raw.campaignId;
        if (raw.includeStaticChecks !== undefined) {
          input.includeStaticChecks = raw.includeStaticChecks;
        }
        if (raw.includeHeuristic !== undefined) {
          input.includeHeuristic = raw.includeHeuristic;
        }

        const deriveDeps: {
          store: AssuranceCampaignStore;
          sandbox?: LocalSandbox;
          attachmentProvider?: AssuranceAttachmentProvider;
          projectDir?: string;
          fetchImpl?: typeof fetch;
        } = { store };
        if (deps.sandbox !== undefined) deriveDeps.sandbox = deps.sandbox;
        if (deps.attachmentProvider !== undefined) {
          deriveDeps.attachmentProvider = deps.attachmentProvider;
        }
        if (deps.projectDir !== undefined) {
          deriveDeps.projectDir = deps.projectDir;
        }
        if (deps.fetchImpl !== undefined) deriveDeps.fetchImpl = deps.fetchImpl;

        const derived = await deriveAssurance(
          input as DeriveAssuranceInput,
          deriveDeps,
        );
        const ceCount = derived.counts.byCertainty["proven-counterexample"];
        const spCount = derived.counts.byCertainty["static-proof"];
        return {
          ok: true,
          summary: `Derived campaign '${derived.campaignId}': ${ceCount} proven counterexample(s), ${spCount} static proof failure(s), ${derived.counts.total} total diagnostic(s)`,
          data: derived,
        };
      } catch (error) {
        return resultError(error);
      }
    },
  };
}
