/**
 * Pure multi-codebase metadata helpers: duplicate export name validation,
 * codebase-tagged ready snapshot merging, event tagging, and execution-log
 * recording for scheduled and Pub/Sub runs.
 */
import type { LocalSandbox } from 'pyric/sandbox';
import type {
  FunctionsChildEvent,
  FunctionsChildHttpBackend,
  FunctionsChildHttpReady,
  FunctionsChildReady,
  FunctionsCodebaseReadySummary,
  FunctionsReadyTriggerInfo,
} from './child-protocol.js';
import { recordFunctionExecution } from './execution-log.js';
import type { HttpFunctionInfo } from './http/discovery.js';
import type { FunctionsCodebaseProject } from './project.js';
import type { PubSubPublishResult } from './pubsub/delivery.js';
import {
  retryConfigToRecord,
  type ScheduledTriggerInvocationResult,
} from './scheduler/execution.js';
import type { UnsupportedFunctionsTrigger } from './unsupported.js';

export interface DuplicateCodebaseExport {
  exportName: string;
  codebases: string[];
}

export interface CodebaseReadySnapshot {
  codebase: FunctionsCodebaseProject;
  ready: FunctionsChildReady;
}

/** Record a scheduled trigger invocation into the sandbox execution log. */
export function recordScheduledExecution(
  sandbox: LocalSandbox | undefined,
  summary: ScheduledTriggerInvocationResult,
  codebase?: string,
): void {
  if (sandbox === undefined) return;
  const ref = summary.jobName ?? `schedule/${summary.exportName}`;
  const params: Record<string, string> = {
    scheduleTime: summary.scheduleTime,
  };
  const retryRecord = retryConfigToRecord(summary.retryConfig);
  const outcome: Parameters<typeof recordFunctionExecution>[1] = {
    trigger: summary.exportName,
    ref,
    params,
    startedAt: summary.startedAt,
    durationMs: summary.durationMs,
    status: summary.status,
  };
  if (codebase !== undefined) {
    outcome.codebase = codebase;
  }
  if (summary.status === 'fulfilled') {
    outcome.result = summary.result;
  } else {
    outcome.error = summary.error;
  }
  if (Object.keys(retryRecord).length > 0) {
    outcome.retryConfig = retryRecord;
  }
  summary.record = recordFunctionExecution(sandbox, outcome);
}

/** Record Pub/Sub trigger deliveries into the sandbox execution log. */
export function recordPubSubDeliveries(
  sandbox: LocalSandbox | undefined,
  summary: PubSubPublishResult,
  codebase?: string,
): void {
  if (sandbox === undefined) return;
  for (const delivery of summary.deliveries) {
    const outcome: Parameters<typeof recordFunctionExecution>[1] = {
      trigger: delivery.exportName,
      ref: summary.topicResource,
      params: {
        topic: summary.topic,
        messageId: summary.messageId,
      },
      startedAt: delivery.startedAt,
      durationMs: delivery.durationMs,
      status: delivery.status,
    };
    if (codebase !== undefined) {
      outcome.codebase = codebase;
    }
    if (delivery.status === 'fulfilled') {
      if (delivery.result !== undefined) {
        outcome.result = delivery.result;
      }
    } else {
      outcome.error = delivery.error?.message ?? 'Unknown error';
    }
    if (delivery.retry) {
      outcome.retryConfig = { retry: 1 };
    }
    recordFunctionExecution(sandbox, outcome);
  }
}

/** Collect every distinct export name declared by one codebase's ready snapshot. */
export function collectCodebaseExportNames(ready: FunctionsChildReady): string[] {
  const seen = new Set<string>();
  for (const name of ready.exportNames ?? []) {
    seen.add(name);
  }
  for (const fn of ready.http?.functions ?? []) {
    seen.add(fn.exportName);
  }
  for (const trigger of ready.triggers ?? []) {
    seen.add(trigger.exportName);
  }
  for (const unsupported of ready.unsupportedTriggers) {
    if (!unsupported.eventType.includes('omitted from emulation')) {
      seen.add(unsupported.exportName);
    }
  }
  return [...seen];
}

/** Find any export names declared by more than one codebase. */
export function findDuplicateCodebaseExports(
  snapshots: readonly CodebaseReadySnapshot[],
): DuplicateCodebaseExport[] {
  const ownersByName = new Map<string, string[]>();
  for (const { codebase, ready } of snapshots) {
    for (const exportName of collectCodebaseExportNames(ready)) {
      let owners = ownersByName.get(exportName);
      if (owners === undefined) {
        owners = [];
        ownersByName.set(exportName, owners);
      }
      if (!owners.includes(codebase.codebase)) {
        owners.push(codebase.codebase);
      }
    }
  }
  const duplicates: DuplicateCodebaseExport[] = [];
  for (const [exportName, codebases] of ownersByName) {
    if (codebases.length > 1) {
      duplicates.push({ exportName, codebases });
    }
  }
  return duplicates;
}

/** Build a clear diagnostic error listing every duplicate export name across codebases. */
export function formatDuplicateCodebaseExportsError(
  duplicates: readonly DuplicateCodebaseExport[],
): Error {
  const details = duplicates
    .map(
      ({ exportName, codebases }) =>
        `"${exportName}" (${codebases.map((name) => `"${name}"`).join(', ')})`,
    )
    .join('; ');
  return new Error(
    `pyric sandbox: duplicate Functions export name(s) across codebases: ${details}. ` +
      'Export names must be unique across codebases in firebase.json.',
  );
}

/** Attach `codebase` metadata to a single codebase's `FunctionsChildReady`. */
export function tagReadyWithCodebase(
  ready: FunctionsChildReady,
  codebase: FunctionsCodebaseProject,
): FunctionsChildReady {
  const cbName = codebase.codebase;
  const unsupportedTriggers: UnsupportedFunctionsTrigger[] = ready.unsupportedTriggers.map(
    (item) => ({ ...item, codebase: item.codebase ?? cbName }),
  );
  const tagged: FunctionsChildReady = {
    triggerCount: ready.triggerCount,
    unsupportedTriggers,
  };
  if (ready.http !== undefined) {
    const taggedFns: HttpFunctionInfo[] = ready.http.functions.map((fn) => ({
      ...fn,
      codebase: fn.codebase ?? cbName,
    }));
    const taggedHttp: FunctionsChildHttpReady = {
      port: ready.http.port,
      token: ready.http.token,
      functions: taggedFns,
    };
    if (ready.http.backends !== undefined) {
      taggedHttp.backends = ready.http.backends;
    }
    tagged.http = taggedHttp;
  }
  if (ready.exportNames !== undefined) {
    tagged.exportNames = [...ready.exportNames];
  }
  if (ready.triggers !== undefined) {
    tagged.triggers = ready.triggers.map((trigger) => ({
      ...trigger,
      codebase: trigger.codebase ?? cbName,
    }));
  } else if (tagged.http !== undefined) {
    tagged.triggers = tagged.http.functions.map((fn) => ({
      exportName: fn.exportName,
      kind: fn.kind === 'callable' ? 'callable' : 'http',
      codebase: cbName,
      regions: fn.regions,
    }));
  }
  tagged.codebases = [
    {
      codebase: cbName,
      sourceDir: codebase.sourceDir,
      entry: codebase.entry,
      triggerCount: ready.triggerCount,
      httpFunctionCount: tagged.http?.functions.length ?? 0,
      unsupportedTriggers,
    },
  ];
  return tagged;
}

/** Attach `codebase` metadata to a child IPC event. */
export function tagChildEventWithCodebase(
  event: FunctionsChildEvent,
  codebase: string,
): FunctionsChildEvent {
  if (event.codebase !== undefined) return event;
  return { ...event, codebase };
}

/** Merge ready snapshots from multiple codebases into one unified `FunctionsChildReady`. */
export function mergeCodebaseReadySnapshots(
  snapshots: readonly CodebaseReadySnapshot[],
): FunctionsChildReady {
  let triggerCount = 0;
  const unsupportedTriggers: UnsupportedFunctionsTrigger[] = [];
  const exportNames: string[] = [];
  const triggers: FunctionsReadyTriggerInfo[] = [];
  const codebases: FunctionsCodebaseReadySummary[] = [];
  const backends: FunctionsChildHttpBackend[] = [];
  const allHttpFunctions: HttpFunctionInfo[] = [];

  for (const { codebase, ready } of snapshots) {
    const tagged = tagReadyWithCodebase(ready, codebase);
    triggerCount += tagged.triggerCount;
    unsupportedTriggers.push(...tagged.unsupportedTriggers);
    for (const name of collectCodebaseExportNames(tagged)) {
      exportNames.push(name);
    }
    if (tagged.triggers !== undefined) {
      triggers.push(...tagged.triggers);
    }
    if (tagged.codebases !== undefined) {
      codebases.push(...tagged.codebases);
    }
    if (tagged.http !== undefined && tagged.http.functions.length > 0) {
      backends.push({
        codebase: codebase.codebase,
        port: tagged.http.port,
        token: tagged.http.token,
        functions: tagged.http.functions,
      });
      allHttpFunctions.push(...tagged.http.functions);
    }
  }

  const merged: FunctionsChildReady = {
    triggerCount,
    unsupportedTriggers,
    exportNames,
    triggers,
    codebases,
  };
  const primaryBackend = backends[0];
  if (primaryBackend !== undefined) {
    merged.http = {
      port: primaryBackend.port,
      token: primaryBackend.token,
      functions: allHttpFunctions,
      backends,
    };
  }
  return merged;
}
