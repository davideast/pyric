/**
 * Delivery seam for Firestore v2 document triggers.
 */
import type {
  FirestoreDocumentVersion,
  FirestoreTriggerAuthType,
} from './event.js';

export interface FirestoreMutationRecord {
  readonly database: string;
  readonly document: string;
  readonly before: FirestoreDocumentVersion | null;
  readonly after: FirestoreDocumentVersion | null;
  readonly time: string;
  updateMask?: readonly string[];
  readonly authType?: FirestoreTriggerAuthType;
  authId?: string;
}

export interface FirestoreDeliveryCallbacks {
  onReady?(): void;
  onMutation(mutation: FirestoreMutationRecord): void;
  onError?(error: unknown): void;
}

export interface FirestoreTriggerDelivery {
  subscribe(
    database: string,
    callbacks: FirestoreDeliveryCallbacks,
  ): () => void;
}
