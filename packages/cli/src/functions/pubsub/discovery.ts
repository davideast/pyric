/**
 * Discovery and topic filter resolution for `firebase-functions/v2/pubsub`
 * triggers (`google.cloud.pubsub.topic.v1.messagePublished`).
 */
import {
  classifyEndpointOmit,
  isResetValueObject,
  listFirebaseEndpoints,
  type FirebaseEndpoint,
} from '../endpoints.js';
import type { FunctionsTriggerFamily } from '../unsupported.js';

export const MESSAGE_PUBLISHED_EVENT_TYPE =
  'google.cloud.pubsub.topic.v1.messagePublished';

const DEFAULT_FALLBACK_PROJECT_ID = 'demo-project';
const QUALIFIED_TOPIC_PATTERN = /^projects\/([^/\s]+)\/topics\/([^/\s]+)$/;

type PubSubTriggerCallable = (
  rawEvent: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface ResolvedPubSubTopic {
  projectId: string;
  topicId: string;
  explicitProject?: string;
  resourceName: string;
}

export interface DiscoveredPubSubTrigger {
  exportName: string;
  eventType: typeof MESSAGE_PUBLISHED_EVENT_TYPE;
  rawTopic: string;
  topic: string;
  topicProject?: string;
  topicResource: string;
  retry: boolean;
  location?: string;
  timeoutSeconds?: number;
  callable: PubSubTriggerCallable;
}

interface UnsupportedPubSubTrigger {
  exportName: string;
  eventType: string;
}

export interface PubSubTriggerInspection {
  triggers: DiscoveredPubSubTrigger[];
  unsupported: UnsupportedPubSubTrigger[];
}

export interface InspectPubSubTriggersOptions {
  projectId?: string;
  env?: NodeJS.ProcessEnv;
}

export function isPubSubEventType(
  value: unknown,
): value is typeof MESSAGE_PUBLISHED_EVENT_TYPE {
  return value === MESSAGE_PUBLISHED_EVENT_TYPE;
}

/** Resolve the default project ID from `FIREBASE_CONFIG` or GCP env vars. */
export function defaultProjectIdFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fallbackProjectId = DEFAULT_FALLBACK_PROJECT_ID,
): string {
  const rawConfig = env.FIREBASE_CONFIG;
  if (typeof rawConfig === 'string' && rawConfig.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawConfig) as { projectId?: unknown };
      if (typeof parsed.projectId === 'string' && parsed.projectId.length > 0) {
        return parsed.projectId;
      }
    } catch {
      // Ignore malformed FIREBASE_CONFIG JSON and fall back to project env vars.
    }
  }
  if (typeof env.GCLOUD_PROJECT === 'string' && env.GCLOUD_PROJECT.length > 0) {
    return env.GCLOUD_PROJECT;
  }
  if (
    typeof env.GOOGLE_CLOUD_PROJECT === 'string' &&
    env.GOOGLE_CLOUD_PROJECT.length > 0
  ) {
    return env.GOOGLE_CLOUD_PROJECT;
  }
  if (typeof env.GCP_PROJECT === 'string' && env.GCP_PROJECT.length > 0) {
    return env.GCP_PROJECT;
  }
  return fallbackProjectId;
}

function tryResolvePubSubTopic(
  rawTopic: string,
  defaultProjectId: string,
): ResolvedPubSubTopic | null {
  if (rawTopic.length === 0 || /\s/.test(rawTopic)) {
    return null;
  }
  if (rawTopic.startsWith('projects/')) {
    const match = QUALIFIED_TOPIC_PATTERN.exec(rawTopic);
    if (match === null) return null;
    const projectId = match[1];
    const topicId = match[2];
    if (projectId === undefined || topicId === undefined) return null;
    return {
      projectId,
      topicId,
      explicitProject: projectId,
      resourceName: `projects/${projectId}/topics/${topicId}`,
    };
  }
  if (rawTopic.includes('/')) {
    return null;
  }
  return {
    projectId: defaultProjectId,
    topicId: rawTopic,
    resourceName: `projects/${defaultProjectId}/topics/${rawTopic}`,
  };
}

/**
 * Normalize either a short topic name (`orders`) or a qualified topic resource
 * (`projects/<project>/topics/<topic>`) against `defaultProjectId`.
 */
export function normalizePubSubTopic(
  rawTopic: string,
  defaultProjectId = DEFAULT_FALLBACK_PROJECT_ID,
): ResolvedPubSubTopic {
  if (typeof rawTopic !== 'string') {
    throw new TypeError('Pub/Sub topic must be a non-empty string.');
  }
  const resolved = tryResolvePubSubTopic(rawTopic, defaultProjectId);
  if (resolved === null) {
    throw new Error(
      `Invalid Pub/Sub topic '${rawTopic}'. Expected a topic short name or 'projects/<project>/topics/<topic>'.`,
    );
  }
  return resolved;
}

function parseEndpointLocation(
  region: unknown,
): { ok: true; location?: string } | { ok: false } {
  if (region === undefined || region === null || isResetValueObject(region)) {
    return { ok: true };
  }
  if (typeof region === 'string') {
    if (region.length === 0) return { ok: false };
    return { ok: true, location: region };
  }
  if (Array.isArray(region)) {
    if (region.length === 0) return { ok: true };
    const allStrings = region.every(
      (item) => typeof item === 'string' && item.length > 0,
    );
    if (!allStrings) return { ok: false };
    const first = region[0];
    if (typeof first === 'string') {
      return { ok: true, location: first };
    }
    return { ok: true };
  }
  return { ok: false };
}

function parseEndpointRetry(
  retry: unknown,
): { ok: true; retry: boolean } | { ok: false } {
  if (retry === true) return { ok: true, retry: true };
  if (
    retry === undefined ||
    retry === null ||
    retry === false ||
    isResetValueObject(retry)
  ) {
    return { ok: true, retry: false };
  }
  return { ok: false };
}

function parseEndpointTimeoutSeconds(
  timeoutSeconds: unknown,
): { ok: true; timeoutSeconds?: number } | { ok: false } {
  if (
    timeoutSeconds === undefined ||
    timeoutSeconds === null ||
    isResetValueObject(timeoutSeconds)
  ) {
    return { ok: true };
  }
  if (typeof timeoutSeconds === 'number') {
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
      return { ok: false };
    }
    if (timeoutSeconds === 0) {
      return { ok: true };
    }
    return { ok: true, timeoutSeconds };
  }
  return { ok: false };
}

/**
 * Inspect exported functions for `firebase-functions/v2/pubsub` triggers,
 * classifying omitted, malformed-topic, or dynamic-expression endpoints.
 */
export function inspectPubSubTriggers(
  exported: Record<string, unknown>,
  options: InspectPubSubTriggersOptions = {},
): PubSubTriggerInspection {
  const effectiveProjectId =
    options.projectId ?? defaultProjectIdFromEnv(options.env);
  const triggers: DiscoveredPubSubTrigger[] = [];
  const unsupported: UnsupportedPubSubTrigger[] = [];

  for (const { exportName, callable } of listFirebaseEndpoints<PubSubTriggerCallable>(
    exported,
  )) {
    const endpoint = callable.__endpoint;
    const eventTrigger = endpoint?.eventTrigger;
    const eventType = eventTrigger?.eventType;
    if (!isPubSubEventType(eventType)) continue;

    const omitState = classifyEndpointOmit(endpoint?.omit);
    if (omitState === 'omitted') {
      unsupported.push({
        exportName,
        eventType: `${eventType} (omitted from emulation)`,
      });
      continue;
    }
    if (omitState === 'dynamic') {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic omit option)`,
      });
      continue;
    }

    const rawTopic = eventTrigger?.eventFilters?.topic;
    if (typeof rawTopic !== 'string') {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic topic option)`,
      });
      continue;
    }

    const resolvedTopic = tryResolvePubSubTopic(rawTopic, effectiveProjectId);
    if (resolvedTopic === null) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (invalid topic filter)`,
      });
      continue;
    }

    const parsedLocation = parseEndpointLocation(endpoint?.region);
    if (!parsedLocation.ok) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic region option)`,
      });
      continue;
    }

    const rawRetry = (eventTrigger as { retry?: unknown } | undefined)?.retry;
    const parsedRetry = parseEndpointRetry(rawRetry);
    if (!parsedRetry.ok) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic retry option)`,
      });
      continue;
    }

    const parsedTimeout = parseEndpointTimeoutSeconds(endpoint?.timeoutSeconds);
    if (!parsedTimeout.ok) {
      unsupported.push({
        exportName,
        eventType: `${eventType} (unsupported dynamic timeoutSeconds option)`,
      });
      continue;
    }

    const discovered: DiscoveredPubSubTrigger = {
      exportName,
      eventType,
      rawTopic,
      topic: resolvedTopic.topicId,
      topicResource: resolvedTopic.resourceName,
      retry: parsedRetry.retry,
      callable,
    };
    if (resolvedTopic.explicitProject !== undefined) {
      discovered.topicProject = resolvedTopic.explicitProject;
    }
    if (parsedLocation.location !== undefined) {
      discovered.location = parsedLocation.location;
    }
    if (parsedTimeout.timeoutSeconds !== undefined) {
      discovered.timeoutSeconds = parsedTimeout.timeoutSeconds;
    }
    triggers.push(discovered);
  }

  return { triggers, unsupported };
}

/** Discover active Pub/Sub triggers ready for runtime execution. */
export function discoverPubSubTriggers(
  exported: Record<string, unknown>,
  options: InspectPubSubTriggersOptions = {},
): DiscoveredPubSubTrigger[] {
  return inspectPubSubTriggers(exported, options).triggers;
}

/**
 * Whether a published topic targets `trigger`'s configured topic filter,
 * matching both short topic names and `projects/<project>/topics/<topic>`.
 */
export function matchesPubSubTopic(
  trigger: DiscoveredPubSubTrigger,
  candidateTopic: string | ResolvedPubSubTopic,
  defaultProjectId = DEFAULT_FALLBACK_PROJECT_ID,
): boolean {
  let resolved: ResolvedPubSubTopic | null;
  if (typeof candidateTopic === 'string') {
    resolved = tryResolvePubSubTopic(candidateTopic, defaultProjectId);
  } else {
    resolved = candidateTopic;
  }
  if (resolved === null) return false;

  const triggerProject = trigger.topicProject ?? defaultProjectId;
  return trigger.topic === resolved.topicId && triggerProject === resolved.projectId;
}

/** The v2 Cloud Pub/Sub trigger family (`google.cloud.pubsub.topic.v1.messagePublished`). */
export const pubsubTriggersFamily: FunctionsTriggerFamily = {
  claims: (endpoint: FirebaseEndpoint) =>
    isPubSubEventType(endpoint.eventTrigger?.eventType),
  unsupported: (exported: Record<string, unknown>) =>
    inspectPubSubTriggers(exported).unsupported,
};
