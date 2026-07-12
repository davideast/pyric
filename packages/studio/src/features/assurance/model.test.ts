import { describe, expect, it } from "bun:test";
import type { AuthorizationCampaignReport } from "@pyric/cli/assurance";
import {
  projectAssuranceRows,
  summarizeStateDiff,
  toRuleDecision,
} from "./model.js";

const report: AuthorizationCampaignReport = {
  schema: "pyric.assurance.report.v1",
  campaignId: "room-campaign",
  targetHash: "fnv1a32-12345678",
  localOnly: { network: "forbid", engine: "pyric-local-sandboxes" },
  summary: {
    probes: 1,
    controlsPassed: 1,
    localCounterexamples: 1,
    candidateSignals: 0,
    noCounterexamples: 0,
    engineGaps: 0,
    invalidProbes: 0,
  },
  results: [
    {
      campaignId: "room-campaign",
      probeId: "owner-transfer",
      targetHash: "fnv1a32-12345678",
      actorEvidence: {
        actorId: "member-b",
        acquisition: "password",
        reachability: "reachable",
        uid: "mallory",
      },
      invariant: {
        id: "owner-immutable",
        statement: "A member must not transfer ownership.",
        service: "firestore",
        expected: "DENY",
        source: "declared",
        confidence: "authoritative",
      },
      mutationSpec: {
        dimension: "payload",
        description: "Change only ownerId.",
        operation: {
          service: "firestore",
          method: "update",
          path: "rooms/r1",
          data: { ownerId: "mallory" },
        },
      },
      control: {
        operation: {
          service: "firestore",
          method: "update",
          path: "rooms/r1",
          data: { title: "Edited" },
        },
        decision: "ALLOW",
        events: [],
      },
      mutation: {
        operation: {
          service: "firestore",
          method: "update",
          path: "rooms/r1",
          data: { ownerId: "mallory" },
        },
        decision: "ALLOW",
        events: [
          {
            id: "req-1",
            at: 100,
            kind: "request",
            service: "firestore",
            method: "update",
            path: "rooms/r1",
            result: "allow",
            auth: { uid: "mallory", token: {} },
            reasons: ["Rule #1 (update) -> ALLOW"],
            origin: "user",
            request: { resourceData: { ownerId: "mallory" } },
            resourceBefore: {
              exists: true,
              data: { ownerId: "alice", title: "Room" },
            },
            matchedRule: { ruleIndex: 0, operations: ["update"] },
          },
        ],
      },
      stateDiff: {
        changed: true,
        before: { ownerId: "alice", title: "Room" },
        after: { ownerId: "mallory", title: "Room" },
      },
      qualification: {
        engine: "pyric-local-sandboxes",
        supported: true,
        requirements: [],
      },
      classification: "local-counterexample",
    },
  ],
};

describe("assurance Studio model", () => {
  it("projects expected, observed, actor, impact, and fidelity into matrix rows", () => {
    expect(projectAssuranceRows(report)).toEqual([
      {
        id: "owner-transfer",
        service: "firestore",
        operation: "update rooms/r1",
        actor: "mallory",
        expected: "DENY",
        observed: "ALLOW",
        classification: "local-counterexample",
        impact: "ownerId: alice -> mallory",
        supported: true,
      },
    ]);
    expect(summarizeStateDiff(report.results[0]!)).toBe(
      "ownerId: alice -> mallory",
    );
  });

  it("adapts a correlated rules event for the existing RulesDebug decision inspector", () => {
    expect(toRuleDecision(report.results[0]!)).toMatchObject({
      id: "req-1",
      result: "allow",
      method: "update",
      service: "firestore",
      path: "rooms/r1",
      auth: { uid: "mallory" },
      resourceData: { ownerId: "mallory" },
      resourceBefore: { exists: true, data: { ownerId: "alice" } },
      matchedRule: { ruleIndex: 0, operations: ["update"] },
    });
  });

  it("does not invent a rule decision when a service emitted only state evidence", () => {
    const result = structuredClone(report.results[0]!);
    result.mutation.events = [{ kind: "service_mutation", service: "storage" }];
    expect(toRuleDecision(result)).toBeNull();
  });
});
