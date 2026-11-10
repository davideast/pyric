// Internal engine seams, all on the browser-safe `pyric/rules/internal` entry
// (this runtime ships to the browser, so the Node-only `internal/rtdb` entry is
// not reachable from here):
//
//   rulesSourceRejection — production's Firestore load check, the one every
//   CLI load path runs: the source parses, its service is cloud.firestore,
//   and it is within the compile limits. rulesGrammarRejection is its parse
//   and compile-limit half, for Storage, which checks its own service.
//
//   parseToASTOrError / MatchBlock / PathSegment — the public API exposes
//   lint/simulate but no parsed AST, and the overlapping-match analysis below
//   must walk the match tree to detect production OR composition.
//
//   parseRtdbExpression — a target carries COMPILED RTDB `{ rules }` JSON, and
//   `rtdbRules(compiledJson).lint()` returns nothing (a compiled document has
//   no IR to lint against). The per-expression parse check below therefore
//   reaches the expression parser directly.
import {
  parseToASTOrError,
  parseRtdbExpression,
  rulesGrammarRejection,
  rulesSourceRejection,
  type MatchBlock,
  type PathSegment,
} from "pyric/rules/internal";
import { rtdbRulesSourceRejection } from "pyric/rules/internal/rtdb";
import { resolveDatabaseInstance } from "pyric/sandbox/internal";
import { compileStorageRules } from "pyric/storage/internal";
import { normalizeStorageBucketInstance } from "./validation-target.js";
import {
  CONFORMANCE_VERDICTS,
  type ConformanceVerdict,
} from "./.generated/conformance-verdicts.js";
import type {
  AssuranceProbe,
  CapabilityDependency,
  CapabilityRequirement,
  EngineQualification,
  LocalFirebaseTarget,
} from "./types.js";

/**
 * A probe's `requires` names graph nodes (constructs, registry rows) directly,
 * and the engine resolves each against the node's derived verdict. The lookup
 * contains every addressable graph node and is regenerated before compilation;
 * it is not an authored or committed capability catalog.
 */
export function verdictOf(nodeId: string): ConformanceVerdict | undefined {
  return Object.prototype.hasOwnProperty.call(CONFORMANCE_VERDICTS, nodeId)
    ? CONFORMANCE_VERDICTS[nodeId as keyof typeof CONFORMANCE_VERDICTS]
    : undefined;
}

/**
 * Resolve one `requires` node against the derived graph verdict, appending a
 * requirement. A `supported` node passes; a `qualified`/`unsupported` node
 * abstains (engine-gap); a node the graph does not model is an authoring error
 * (invalid-probe).
 */
function resolveRequiredNode(
  dependency: CapabilityDependency,
  requirements: CapabilityRequirement[],
): EngineQualification["classification"] | undefined {
  const verdict = verdictOf(dependency.id);
  if (!verdict) {
    requirements.push(
      requirement(
        dependency.id,
        false,
        `The probe requires ${dependency.kind} '${dependency.id}', which the conformance graph does not model.`,
      ),
    );
    return "invalid-probe";
  }
  if (verdict !== "supported") {
    requirements.push(
      requirement(
        dependency.id,
        false,
        `The ${dependency.kind} '${dependency.id}' is derived '${verdict}', not 'supported'; the engine abstains.`,
      ),
    );
    return "engine-gap";
  }
  requirements.push(
    requirement(dependency.id, true, `The ${dependency.kind} '${dependency.id}' is derived 'supported'.`),
  );
  return undefined;
}

function requirement(
  id: string,
  supported: boolean,
  reason: string,
): CapabilityRequirement {
  return { id, supported, reason };
}

function storageRulesSourceRefusal(source: string): string | undefined {
  // Storage checks its own service in `compileStorageRules`; the shared
  // check here is the parse and compile-limit half only.
  const rejection = rulesGrammarRejection(source);
  if (rejection !== null) return `Storage ${rejection.message}`;
  try {
    compileStorageRules(source);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.startsWith("Storage ")
      ? message
      : `Storage rules did not compile: ${message}`;
  }
}

/**
 * Why production would refuse to load the rules a service runs under, in
 * production's words (`Firestore rules did not compile: Line 4: Expression is
 * too complex to evaluate safely.`), or undefined when it would load them.
 */
export function rulesLoadRefusal(
  target: LocalFirebaseTarget,
  service: AssuranceProbe["control"]["service"],
): string | undefined {
  if (service === "rtdb") {
    if (target.rules.rtdb) {
      const rejection = rtdbRulesSourceRejection(target.rules.rtdb);
      if (rejection !== null) return rejection.message;
    }
    if (target.rules.rtdbInstances) {
      for (const [instanceName, instanceRules] of Object.entries(target.rules.rtdbInstances)) {
        const rejection = rtdbRulesSourceRejection(instanceRules as any);
        if (rejection !== null) return `instance '${instanceName}': ${rejection.message}`;
      }
    }
    return undefined;
  }
  if (service === "firestore") {
    const source = target.rules.firestore;
    if (typeof source !== "string" || source.trim().length === 0) return undefined;
    const rejection = rulesSourceRejection(source);
    return rejection === null ? undefined : `Firestore ${rejection.message}`;
  }
  if (
    typeof target.rules.storage === "string" &&
    target.rules.storage.trim().length > 0
  ) {
    const refusal = storageRulesSourceRefusal(target.rules.storage);
    if (refusal !== undefined) return refusal;
  }
  if (target.rules.storageBuckets) {
    for (const [bucketName, bucketSource] of Object.entries(
      target.rules.storageBuckets,
    )) {
      if (typeof bucketSource === "string" && bucketSource.trim().length > 0) {
        const refusal = storageRulesSourceRefusal(bucketSource);
        if (refusal !== undefined) return `bucket '${bucketName}': ${refusal}`;
      }
    }
  }
  return undefined;
}

/** The requirement that production would load a service's rules source. */
function rulesLoadRequirement(
  target: LocalFirebaseTarget,
  service: "firestore" | "rtdb" | "storage",
): CapabilityRequirement {
  const refusal = rulesLoadRefusal(target, service);
  const name =
    service === "firestore"
      ? "Firestore"
      : service === "rtdb"
        ? "RTDB"
        : "Storage";
  return requirement(
    `${service}.rules-load`,
    refusal === undefined,
    refusal ??
      `The ${name} rules source parses and is within production's compile limits.`,
  );
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

function rtdbOperationTargetSegmentLists(
  operation: AssuranceProbe["control"],
): string[][] {
  if (operation.service !== "rtdb") return [];
  const baseSegments = operation.path.split("/").filter(Boolean);
  if (
    operation.method === "update" &&
    operation.data &&
    typeof operation.data === "object" &&
    !Array.isArray(operation.data)
  ) {
    const keys = Object.keys(operation.data as Record<string, unknown>);
    if (keys.length > 0) {
      return keys.map((relKey) => [
        ...baseSegments,
        ...relKey.split("/").filter(Boolean),
      ]);
    }
  }
  return [baseSegments];
}

function rtdbRuleAppliesToOperation(
  rule: RtdbRuleSource,
  operation: AssuranceProbe["control"],
): boolean {
  if (operation.service !== "rtdb") return false;
  const isRead = operation.method === "get";
  return rtdbOperationTargetSegmentLists(operation).some((segments) => {
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
  });
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

  const load = rulesLoadRequirement(target, "firestore");
  requirements.push(load);
  if (!load.supported) return requirements;

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

function resolveRtdbRulesForOperation(
  target: LocalFirebaseTarget,
  operation: AssuranceProbe["control"],
): { rules: Record<string, unknown> } | undefined {
  if (operation.service !== "rtdb") return undefined;
  if (
    !operation.instance ||
    operation.instance === "default" ||
    operation.instance === "(default)"
  ) {
    return target.rules.rtdb;
  }
  let resolvedName: string | undefined;
  try {
    resolvedName = resolveDatabaseInstance(operation.instance)?.name;
  } catch {
    return undefined;
  }
  if (!resolvedName || !target.rules.rtdbInstances) return undefined;
  const declaredEntry = Object.entries(target.rules.rtdbInstances).find(
    ([key]) => {
      try {
        return resolveDatabaseInstance(key)?.name === resolvedName;
      } catch {
        return false;
      }
    },
  );
  return declaredEntry
    ? (declaredEntry[1] as { rules: Record<string, unknown> })
    : undefined;
}

function rtdbRequirements(
  target: LocalFirebaseTarget,
  probe: AssuranceProbe,
): CapabilityRequirement[] {
  const operations = [probe.control, probe.mutation.operation].filter(
    (op) => op.service === "rtdb",
  );
  const operationRules = operations.map((operation) => ({
    operation,
    rules: resolveRtdbRulesForOperation(target, operation),
  }));
  const allRulesPresent =
    operationRules.length > 0 &&
    operationRules.every((entry) => Boolean(entry.rules));
  const anyRulesPresent = operationRules.some((entry) => Boolean(entry.rules));

  const applicableRules = operationRules.flatMap(({ operation, rules }) =>
    rules
      ? collectRtdbRuleSources(rules.rules)
          .filter((rule) => rtdbRuleAppliesToOperation(rule, operation))
          .map((rule) => ({
            operation,
            rule,
            parsed: rule.source ? parseRtdbExpression(rule.source) : undefined,
          }))
      : [],
  );

  const invalidExpressions = [
    ...new Set(
      applicableRules
        .filter(({ parsed }) => !parsed || !parsed.valid)
        .map(({ rule }) => rule.path),
    ),
  ];
  const queryDependent = applicableRules.some(
    ({ parsed }) => parsed?.referencedIdentifiers.includes("query") ?? false,
  );
  const ancestorDataDependent = applicableRules.some(
    ({ operation, rule, parsed }) => {
      const usesDataOrNewData =
        (parsed?.referencedIdentifiers.includes("data") ?? false) ||
        (parsed?.referencedIdentifiers.includes("newData") ?? false);
      if (!usesDataOrNewData) return false;
      return rtdbOperationTargetSegmentLists(operation).some(
        (opSegments) => rule.segments.length < opSegments.length,
      );
    },
  );
  const queryVerdict = verdictOf("rtdb.binding.query");
  const querySupported = !queryDependent || queryVerdict === "supported";
  const ancestorDataVerdict = verdictOf("rtdb-rules#8");
  const ancestorDataSupported =
    !ancestorDataDependent || ancestorDataVerdict === "supported";
  const requirements = [
    requirement(
      "rtdb.rules-present",
      allRulesPresent,
      "RTDB probes require an explicit rules JSON document.",
    ),
    ...(anyRulesPresent ? [rulesLoadRequirement(target, "rtdb")] : []),
    requirement(
      "rtdb.rules-parse",
      invalidExpressions.length === 0,
      invalidExpressions.length === 0
        ? "All RTDB expressions relevant to the probed paths parsed successfully."
        : `RTDB rule expressions did not parse at: ${invalidExpressions.join(", ")}.`,
    ),
    requirement(
      "rtdb.query-rules",
      querySupported,
      !queryDependent
        ? "The rules used by this probe do not authorize from query constraints."
        : querySupported
          ? "RTDB query-constraint rule semantics are derived 'supported' from 'rtdb.binding.query'."
          : `The conformance construct 'rtdb.binding.query' is derived '${queryVerdict ?? "unmodeled"}', not 'supported'; the engine abstains on query-dependent RTDB rules.`,
    ),
    requirement(
      "rtdb.rule-location-data",
      ancestorDataSupported,
      !ancestorDataDependent
        ? "The rules used by this probe do not depend on data/newData."
        : ancestorDataSupported
          ? "Ancestor rule-location data/newData merged-tree semantics are derived 'supported' from 'rtdb-rules#8'."
          : `The conformance row 'rtdb-rules#8' is derived '${ancestorDataVerdict ?? "unmodeled"}', not 'supported'; the engine abstains on ancestor rule-location data/newData.`,
    ),
  ];

  const multiPathVerdict = verdictOf("rtdb-rules#24");
  for (const operation of operations) {
    if (operation.service !== "rtdb" || operation.method !== "update") continue;
    const keys =
      operation.data &&
      typeof operation.data === "object" &&
      !Array.isArray(operation.data)
        ? Object.keys(operation.data as Record<string, unknown>)
        : [];
    const multiPathSupported =
      keys.length <= 1 || multiPathVerdict === "supported";
    requirements.push(
      requirement(
        "rtdb.atomic-multipath",
        multiPathSupported,
        keys.length <= 1
          ? "The update changes at most one child."
          : multiPathSupported
            ? "Multi-path atomic RTDB update semantics are derived 'supported' from 'rtdb-rules#24'."
            : `The conformance row 'rtdb-rules#24' is derived '${multiPathVerdict ?? "unmodeled"}', not 'supported'; the engine abstains on multi-child updates.`,
      ),
    );
  }
  return requirements;
}

interface ResolvedStorageRules {
  configured: boolean;
  source?: string;
}

function resolveStorageRulesForOperation(
  target: LocalFirebaseTarget,
  operation: AssuranceProbe["control"],
): ResolvedStorageRules {
  if (operation.service !== "storage") return { configured: false };
  const rawBucket =
    (operation as { instance?: string; bucket?: string }).instance ??
    (operation as { instance?: string; bucket?: string }).bucket;
  const normalized = normalizeStorageBucketInstance(rawBucket);
  const bucketRules = target.rules.storageBuckets;
  let matchedBucketSource: string | undefined;
  if (bucketRules) {
    if (normalized !== undefined && Object.hasOwn(bucketRules, normalized)) {
      matchedBucketSource = bucketRules[normalized];
    } else {
      for (const [key, value] of Object.entries(bucketRules)) {
        if (normalizeStorageBucketInstance(key) === normalized) {
          matchedBucketSource = value;
          break;
        }
      }
    }
  }
  const defaultSource =
    typeof target.rules.storage === "string" &&
    target.rules.storage.trim().length > 0
      ? target.rules.storage
      : undefined;
  const undeployedPolicy = target.state.storageConfig?.undeployedBucketPolicy;

  if (normalized === undefined) {
    const source =
      defaultSource ??
      (typeof matchedBucketSource === "string" &&
      matchedBucketSource.trim().length > 0
        ? matchedBucketSource
        : undefined);
    if (source !== undefined) return { configured: true, source };
    if (undeployedPolicy === "allow") return { configured: true };
    return { configured: false };
  }

  if (
    typeof matchedBucketSource === "string" &&
    matchedBucketSource.trim().length > 0
  ) {
    return { configured: true, source: matchedBucketSource };
  }
  if (undeployedPolicy !== undefined) {
    return { configured: true };
  }
  if (bucketRules && Object.keys(bucketRules).length > 0) {
    return { configured: true };
  }
  if (defaultSource !== undefined) {
    return { configured: true, source: defaultSource };
  }
  return { configured: false };
}

function storageRequirements(
  target: LocalFirebaseTarget,
  probe: AssuranceProbe,
): CapabilityRequirement[] {
  const operations = [probe.control, probe.mutation.operation].filter(
    (op) => op.service === "storage",
  );
  const resolved = operations.map((op) =>
    resolveStorageRulesForOperation(target, op),
  );
  const allPresent =
    resolved.length > 0 && resolved.every((entry) => entry.configured);
  const hasStoragePersistence =
    typeof globalThis.indexedDB !== "undefined" ||
    (typeof process !== "undefined" &&
      Boolean(
        process.versions?.node ||
          (process.versions as Record<string, string | undefined> | undefined)?.bun,
      ));
  const requirements = [
    requirement(
      "storage.rules-present",
      allPresent,
      "Storage probes require an explicit rules source.",
    ),
    requirement(
      "storage.indexeddb",
      hasStoragePersistence,
      hasStoragePersistence
        ? "IndexedDB is available for the local Storage sandbox."
        : "The local Storage sandbox requires IndexedDB.",
    ),
  ];
  if (!allPresent) return requirements;
  const load = rulesLoadRequirement(target, "storage");
  requirements.push(load);
  if (!load.supported) return requirements;
  const distinctSources = [
    ...new Set(
      resolved
        .map((entry) => entry.source)
        .filter((s): s is string => typeof s === "string"),
    ),
  ];
  try {
    for (const rules of distinctSources) {
      compileStorageRules(rules);
    }
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
        : storageRequirements(target, probe);

  // A probe names the graph nodes its verdict depends on, and each resolves
  // against the node's DERIVED verdict in the same pass as the structural
  // checks above. Only `supported` proceeds; `qualified`/`unsupported` abstains
  // (engine-gap); a node the graph does not model is a campaign authoring error
  // (invalid-probe), which outranks engine-gap for the single classification.
  let abstention: EngineQualification["classification"];
  for (const dependency of probe.requires ?? []) {
    const nodeAbstention = resolveRequiredNode(dependency, requirements);
    if (nodeAbstention === "invalid-probe") abstention = "invalid-probe";
    else if (nodeAbstention === "engine-gap" && abstention !== "invalid-probe") {
      abstention = "engine-gap";
    }
  }

  return {
    engine: "pyric-local-sandboxes",
    supported: requirements.every((item) => item.supported),
    requirements,
    ...(abstention ? { classification: abstention } : {}),
  };
}
