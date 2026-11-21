/**
 * CloudEvent v2 envelope builder and handler executor for
 * `firebase-functions/v2/firestore` (`7.2.5`).
 */
import type { DiscoveredFirestoreTrigger } from './discovery.js';
import { normalizeFirestoreDocumentPath } from './document-pattern.js';
import {
  encodeFirestoreDocumentEventData,
  type FirestoreTimestampProto,
} from './proto-encoder.js';

export type FirestoreTriggerAuthType =
  | 'service_account'
  | 'api_key'
  | 'system'
  | 'unauthenticated'
  | 'unknown';

export interface FirestoreDocumentVersion {
  readonly fields: Record<string, unknown>;
  readonly createTime: FirestoreTimestampProto;
  readonly updateTime: FirestoreTimestampProto;
}

export interface FirestoreEventBuildInput {
  readonly id: string;
  readonly time: string;
  readonly projectId: string;
  readonly location: string;
  readonly database: string;
  readonly namespace: string;
  readonly document: string;
  readonly before: FirestoreDocumentVersion | null;
  readonly after: FirestoreDocumentVersion | null;
  readonly updateMask?: readonly string[];
  readonly authType?: FirestoreTriggerAuthType;
  readonly authId?: string;
}

export type FirestoreTriggerExecutionResult =
  | { status: 'fulfilled'; event: Record<string, unknown>; result: unknown }
  | { status: 'rejected'; event: Record<string, unknown>; error: unknown };

export const FIRESTORE_EVENT_DATA_SCHEMA =
  'https://github.com/googleapis/google-cloudevents/blob/main/proto/google/events/cloud/firestore/v1/data.proto';

function formatDocumentResourceName(
  projectId: string,
  database: string,
  documentPath: string,
): string {
  const normalized = normalizeFirestoreDocumentPath(documentPath);
  return `projects/${projectId}/databases/${database}/documents/${normalized}`;
}

/** Build a production-shaped Eventarc CloudEvent for `firebase-functions/v2/firestore`. */
export function buildFirestoreCloudEvent(
  eventType: DiscoveredFirestoreTrigger['eventType'],
  withAuthContext: boolean,
  input: FirestoreEventBuildInput,
): Record<string, unknown> {
  const normalizedDoc = normalizeFirestoreDocumentPath(input.document);
  const resourceName = formatDocumentResourceName(
    input.projectId,
    input.database,
    normalizedDoc,
  );
  let valueProto:
    | {
        readonly name: string;
        readonly fields: Record<string, unknown>;
        readonly createTime: FirestoreTimestampProto;
        readonly updateTime: FirestoreTimestampProto;
      }
    | undefined;
  if (input.after !== null) {
    valueProto = {
      name: resourceName,
      fields: input.after.fields,
      createTime: input.after.createTime,
      updateTime: input.after.updateTime,
    };
  }

  let oldValueProto:
    | {
        readonly name: string;
        readonly fields: Record<string, unknown>;
        readonly createTime: FirestoreTimestampProto;
        readonly updateTime: FirestoreTimestampProto;
      }
    | undefined;
  if (input.before !== null) {
    oldValueProto = {
      name: resourceName,
      fields: input.before.fields,
      createTime: input.before.createTime,
      updateTime: input.before.updateTime,
    };
  }

  const protoData = encodeFirestoreDocumentEventData(
    {
      value: valueProto,
      oldValue: oldValueProto,
      updateMask: input.updateMask,
    },
    {
      projectId: input.projectId,
      database: input.database,
    },
  );

  const event: Record<string, unknown> = {
    specversion: '1.0',
    id: input.id,
    source: `//firestore.googleapis.com/projects/${input.projectId}/databases/${input.database}`,
    subject: `documents/${normalizedDoc}`,
    type: eventType,
    time: input.time,
    datacontenttype: 'application/protobuf',
    dataschema: FIRESTORE_EVENT_DATA_SCHEMA,
    location: input.location,
    project: input.projectId,
    database: input.database,
    namespace: input.namespace,
    document: normalizedDoc,
    data: protoData,
  };

  if (withAuthContext) {
    event.authtype = input.authType ?? 'unknown';
    if (input.authId !== undefined) {
      event.authid = input.authId;
    }
  }

  return event;
}

/** Invoke an unchanged `firebase-functions/v2/firestore` trigger callable with a CloudEvent. */
export async function executeFirestoreTrigger(
  trigger: DiscoveredFirestoreTrigger,
  input: FirestoreEventBuildInput,
): Promise<FirestoreTriggerExecutionResult> {
  let event: Record<string, unknown> = {};
  try {
    event = buildFirestoreCloudEvent(
      trigger.eventType,
      trigger.withAuthContext,
      input,
    );
    const result = await trigger.callable(event);
    return { status: 'fulfilled', event, result };
  } catch (error) {
    return { status: 'rejected', event, error };
  }
}
