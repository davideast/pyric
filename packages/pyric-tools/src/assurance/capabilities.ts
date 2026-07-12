import { lint } from "pyric/rules";
// Internal engine seam: the public `pyric/rules` API exposes lint/simulate but
// no parsed AST, and the overlapping-match analysis below must walk the parsed
// match tree (`MatchBlock`/`PathSegment`) to detect production OR composition.
import {
  parseToASTOrError,
  type MatchBlock,
  type PathSegment,
} from "pyric/rules/internal";
// Internal engine seam: a target carries COMPILED RTDB `{ rules }` JSON, and
// `rtdbRules(compiledJson).lint()` returns nothing (there is no IR to lint a
// compiled document against). The per-expression parse check below therefore
// reaches the RTDB expression parser directly.
import { parseExpression as parseRtdbExpression } from "pyric/rules/internal/rtdb";
import { parseStorageRules } from "pyric/storage";
import {
  ASSURANCE_ENGINE_CAPABILITIES,
  type GeneratedAssuranceCapability,
} from "./generated-capabilities.js";
import type {
  AssuranceProbe,
  CapabilityRequirement,
  EngineQualification,
  LocalFirebaseTarget,
} from "./types.js";

export { ASSURANCE_ENGINE_CAPABILITIES };
export type { GeneratedAssuranceCapability };

const CAPABILITY_BY_ID: ReadonlyMap<string, GeneratedAssuranceCapability> =
  new Map(ASSURANCE_ENGINE_CAPABILITIES.map((item) => [item.id, item]));

export function listAssuranceCapabilities(
  services?: ReadonlyArray<GeneratedAssuranceCapability["service"]>,
): GeneratedAssuranceCapability[] {
  return ASSURANCE_ENGINE_CAPABILITIES.filter(
    (item) => !services || services.includes(item.service),
  ).map((item) => ({ ...item, reasons: [...item.reasons] }));
}

function requirement(
  id: string,
  supported: boolean,
  reason: string,
): CapabilityRequirement {
  return { id, supported, reason };
}

interface FirestoreMatchPattern {
  segments: PathSegment[];
  operations: Set<string>;
}

function collectFirestoreMatchPatterns(
  block: MatchBlock,
  prefix: PathSegment[] = [],
): FirestoreMatchPattern[] {
  const segments = [...prefix, ...block.path.segments];
  const current = block.allows.length
    ? [
        {
          segments,
          operations: new Set(
            block.allows.flatMap((allow) => allow.operations),
          ),
        },
      ]
    : [];
  return [
    ...current,
    ...block.children.flatMap((child) =>
      collectFirestoreMatchPatterns(child, segments),
    ),
  ];
}

function patternMatchesPath(pattern: PathSegment[], path: string[]): boolean {
  const visit = (patternIndex: number, pathIndex: number): boolean => {
    if (patternIndex === pattern.length) return pathIndex === path.length;
    const segment = pattern[patternIndex]!;
    if (segment.type === "recursive") {
      if (patternIndex === pattern.length - 1) return true;
      for (let next = pathIndex; next <= path.length; next++) {
        if (visit(patternIndex + 1, next)) return true;
      }
      return false;
    }
    if (pathIndex === path.length) return false;
    if (segment.type === "literal" && segment.value !== path[pathIndex])
      return false;
    return visit(patternIndex + 1, pathIndex + 1);
  };
  return visit(0, 0);
}

function firestoreOperationNames(method: string): string[] {
  if (method === "get") return ["get", "read"];
  if (method === "list") return ["list", "read"];
  if (method === "create") return ["create", "write"];
  if (method === "delete") return ["delete", "write"];
  return ["update", "write"];
}

function hasOverlappingFirestoreMatch(
  root: MatchBlock,
  operation: AssuranceProbe["control"],
): boolean {
  if (operation.service !== "firestore") return false;
  const path = operation.path.split("/").filter(Boolean);
  if (operation.method === "list") path.push("__hypothetical_doc__");
  const operationNames = firestoreOperationNames(operation.method);
  return (
    root.children
      .flatMap((child) => collectFirestoreMatchPatterns(child))
      .filter((pattern) => patternMatchesPath(pattern.segments, path))
      .filter((pattern) =>
        operationNames.some((name) => pattern.operations.has(name)),
      ).length > 1
  );
}

interface RtdbRuleSource {
  path: string;
  source: string;
  kind: ".read" | ".write" | ".validate";
  segments: string[];
}

function collectRtdbRuleSources(
  value: unknown,
  path = "rules",
  segments: string[] = [],
): RtdbRuleSource[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const sources: RtdbRuleSource[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}/${key}`;
    if (key === ".read" || key === ".write" || key === ".validate") {
      if (typeof child === "string" || typeof child === "boolean") {
        sources.push({
          path: childPath,
          source: String(child),
          kind: key,
          segments,
        });
      } else {
        sources.push({ path: childPath, source: "", kind: key, segments });
      }
      continue;
    }
    sources.push(
      ...collectRtdbRuleSources(child, childPath, [...segments, key]),
    );
  }
  return sources;
}

function compatibleRtdbPrefix(
  ruleSegments: string[],
  operationSegments: string[],
  length: number,
): boolean {
  for (let index = 0; index < length; index++) {
    const ruleSegment = ruleSegments[index]!;
    const operationSegment = operationSegments[index]!;
    if (!ruleSegment.startsWith("$") && ruleSegment !== operationSegment) {
      return false;
    }
  }
  return true;
}

function rtdbRuleAppliesToOperation(
  rule: RtdbRuleSource,
  operation: AssuranceProbe["control"],
): boolean {
  if (operation.service !== "rtdb") return false;
  const segments = operation.path.split("/").filter(Boolean);
  const isRead = operation.method === "get";
  if (rule.kind === ".read") {
    return (
      isRead &&
      rule.segments.length <= segments.length &&
      compatibleRtdbPrefix(rule.segments, segments, rule.segments.length)
    );
  }
  if (rule.kind === ".write") {
    return (
      !isRead &&
      rule.segments.length <= segments.length &&
      compatibleRtdbPrefix(rule.segments, segments, rule.segments.length)
    );
  }
  if (isRead) return false;

  const overlapLength = Math.min(rule.segments.length, segments.length);
  return compatibleRtdbPrefix(rule.segments, segments, overlapLength);
}

function firestoreRequirements(
  target: LocalFirebaseTarget,
  probe: AssuranceProbe,
): CapabilityRequirement[] {
  const rules = target.rules.firestore;
  const requirements = [
    requirement(
      "firestore.rules-present",
      typeof rules === "string" && rules.trim().length > 0,
      "Firestore probes require an explicit rules source.",
    ),
  ];
  if (!rules) return requirements;

  // Parse gate via the public tolerant front door: a parse blocker surfaces as
  // a `RuleIssue` with `origin === "parse"`.
  const parseIssue = lint(rules).find((issue) => issue.origin === "parse");
  requirements.push(
    requirement(
      "firestore.rules-parse",
      !parseIssue,
      parseIssue
        ? `The Firestore rules source did not parse: ${parseIssue.message}`
        : "The Firestore rules source parsed successfully.",
    ),
  );
  if (parseIssue) return requirements;

  // The AST walk needs the parsed match tree (no public accessor exists).
  const parsed = parseToASTOrError(rules);
  if (!parsed.ok) return requirements;

  const operations = [probe.control, probe.mutation.operation];
  const overlapping = operations.some((operation) =>
    hasOverlappingFirestoreMatch(parsed.ast.service.match, operation),
  );
  requirements.push(
    requirement(
      "firestore.match-resolution",
      !overlapping,
      overlapping
        ? "This probe matches multiple allow-bearing blocks; the current sandbox resolves only the first block instead of production OR composition."
        : "Each operation resolves to at most one applicable allow-bearing match block.",
    ),
  );

  for (const operation of operations) {
    if (operation.service !== "firestore" || operation.method !== "list")
      continue;
    const equalityOnly = (operation.query?.where ?? []).every(
      (item) => item.op === "==",
    );
    requirements.push(
      requirement(
        "firestore.query-proof-equality",
        equalityOnly,
        equalityOnly
          ? "The query uses the supported equality-proof subset."
          : "Inequality, membership, and disjunctive query proof is conservative in the current simulator.",
      ),
    );
  }
  return requirements;
}

function rtdbRequirements(
  target: LocalFirebaseTarget,
  probe: AssuranceProbe,
): CapabilityRequirement[] {
  const rules = target.rules.rtdb;
  const operations = [probe.control, probe.mutation.operation];
  const ruleSources = rules
    ? collectRtdbRuleSources(rules.rules).filter((rule) =>
        operations.some((operation) =>
          rtdbRuleAppliesToOperation(rule, operation),
        ),
      )
    : [];
  const serialized = ruleSources.map((item) => item.source).join("\n");
  const invalidExpressions = ruleSources
    .filter((item) => !item.source || !parseRtdbExpression(item.source).valid)
    .map((item) => item.path);
  const queryDependent = /\bquery\b/.test(serialized);
  const requirements = [
    requirement(
      "rtdb.rules-present",
      !!rules,
      "RTDB probes require an explicit rules JSON document.",
    ),
    requirement(
      "rtdb.rules-parse",
      invalidExpressions.length === 0,
      invalidExpressions.length === 0
        ? "All RTDB expressions relevant to the probed paths parsed successfully."
        : `RTDB rule expressions did not parse at: ${invalidExpressions.join(", ")}.`,
    ),
    requirement(
      "rtdb.query-rules",
      !queryDependent,
      queryDependent
        ? "The current RTDB evaluator does not expose query constraints to rule expressions."
        : "The rules used by this probe do not authorize from query constraints.",
    ),
    requirement(
      "rtdb.rule-location-data",
      !/\b(?:data|newData)\b/.test(serialized),
      /\b(?:data|newData)\b/.test(serialized)
        ? "The current evaluator cannot prove ancestor rule-location data/newData merged-tree semantics."
        : "The rules used by this probe do not depend on data/newData.",
    ),
  ];

  for (const operation of operations) {
    if (operation.service !== "rtdb" || operation.method !== "update") continue;
    const keys =
      operation.data &&
      typeof operation.data === "object" &&
      !Array.isArray(operation.data)
        ? Object.keys(operation.data as Record<string, unknown>)
        : [];
    requirements.push(
      requirement(
        "rtdb.atomic-multipath",
        keys.length <= 1,
        keys.length <= 1
          ? "The update changes at most one child."
          : "The current local backend checks multi-child updates per leaf instead of one projected future tree.",
      ),
    );
  }
  return requirements;
}

function storageRequirements(
  target: LocalFirebaseTarget,
): CapabilityRequirement[] {
  const rules = target.rules.storage;
  const requirements = [
    requirement(
      "storage.rules-present",
      typeof rules === "string" && rules.trim().length > 0,
      "Storage probes require an explicit rules source.",
    ),
    requirement(
      "storage.indexeddb",
      typeof globalThis.indexedDB !== "undefined",
      typeof globalThis.indexedDB !== "undefined"
        ? "IndexedDB is available for the local Storage sandbox."
        : "The local Storage sandbox requires IndexedDB.",
    ),
  ];
  if (!rules) return requirements;
  try {
    parseStorageRules(rules);
    requirements.push(
      requirement(
        "storage.rules-subset",
        true,
        "The rules parse within the local coarse read/write evaluator subset.",
      ),
    );
  } catch (error) {
    requirements.push(
      requirement(
        "storage.rules-subset",
        false,
        `The Storage rules require unsupported local semantics: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  return requirements;
}

export function qualifyProbe(
  target: LocalFirebaseTarget,
  probe: AssuranceProbe,
): EngineQualification {
  const service = probe.control.service;
  const requirements =
    service === "firestore"
      ? firestoreRequirements(target, probe)
      : service === "rtdb"
        ? rtdbRequirements(target, probe)
        : storageRequirements(target);

  // Resolve each declared capability against the DERIVED graph statuses. Only a
  // `supported` capability lets the probe proceed. A `qualified` or
  // `unsupported` capability forces the engine to abstain (engine-gap), citing
  // the graph reasons the generated capability carries. A capability id the
  // engine does not define is a campaign authoring error (invalid-probe).
  let abstention: EngineQualification["classification"];
  for (const id of probe.requirements ?? []) {
    const capability = CAPABILITY_BY_ID.get(id);
    if (!capability) {
      requirements.push(
        requirement(
          id,
          false,
          `The campaign declared capability '${id}', which the assurance engine does not define.`,
        ),
      );
      abstention = "invalid-probe";
      continue;
    }
    if (capability.status !== "supported") {
      const cited = capability.reasons.length
        ? ` The conformance graph derived this status from: ${capability.reasons.join(" ")}`
        : "";
      requirements.push(
        requirement(
          id,
          false,
          `Capability '${id}' is derived '${capability.status}', not 'supported'; the engine abstains.${cited}`,
        ),
      );
      if (abstention !== "invalid-probe") abstention = "engine-gap";
      continue;
    }
    requirements.push(
      requirement(
        id,
        true,
        `Capability '${id}' is derived 'supported'.`,
      ),
    );
  }
  return {
    engine: "pyric-local-sandboxes",
    supported: requirements.every((item) => item.supported),
    requirements,
    ...(abstention ? { classification: abstention } : {}),
  };
}
