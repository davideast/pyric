import type { Timestamp } from 'firebase/firestore';
import type { ChatMode } from '../chat-mode';

export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type UserId = Brand<string, 'UserId'>;
export type ConversationId = Brand<string, 'ConversationId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type AttachmentId = Brand<string, 'AttachmentId'>;

export const asUserId = (value: string): UserId => value as UserId;
export const asConversationId = (value: string): ConversationId => value as ConversationId;
export const asMessageId = (value: string): MessageId => value as MessageId;
export const asAttachmentId = (value: string): AttachmentId => value as AttachmentId;

export type AuthUser = {
  uid: UserId;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
  emailVerified: boolean;
};

export type UserDocument = {
  uid: UserId;
  displayName: string | null;
  photoURL: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  disabledAt: Timestamp | null;
};

export type ConversationDocument = {
  ownerUid: UserId;
  title: string;
  model: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastMessageAt: Timestamp | null;
  messageCount: number;
  archivedAt: Timestamp | null;
  attachmentCount: number;
  schemaVersion: 1;
};

export type Conversation = ConversationDocument & { id: ConversationId };

export type MessageRole = 'user' | 'assistant' | 'system';
export type FinishReason = 'stop' | 'length' | 'safety' | 'error' | null;

export type MessageDocument = {
  ownerUid: UserId;
  conversationId: ConversationId;
  role: MessageRole;
  text: string;
  createdAt: Timestamp;
  clientMessageId: string | null;
  thoughts: string | null;
  model: string | null;
  finishReason: FinishReason;
  inputTokenCount: number | null;
  outputTokenCount: number | null;
  schemaVersion: 1;
};

export type Message = MessageDocument & { id: MessageId };

export type AttachmentStatus = 'uploading' | 'ready' | 'deleted' | 'rejected';
export type AttachmentDocument = {
  ownerUid: UserId;
  conversationId: ConversationId;
  storagePath: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  generation: string | null;
  createdAt: Timestamp;
  status: AttachmentStatus;
  schemaVersion: 1;
};

export type Attachment = AttachmentDocument & { id: AttachmentId; downloadUrl?: string };

export type PresenceState = 'online' | 'offline';

export type PresenceRecord = {
  uid: UserId;
  state: PresenceState;
  displayName: string | null;
  at: number | object;
};

export type PresenceEntry = {
  uid: UserId;
  state: PresenceState;
  displayName: string | null;
};

export type NotificationMessage = {
  title: string;
  body: string | null;
  data: Record<string, string>;
};

export type PageOptions = {
  pageSize?: number;
  cursor?: unknown;
};

export type Page<T> = {
  items: T[];
  nextCursor: unknown | null;
};

export type CreateConversationInput = {
  title?: string;
  model?: string;
};

export type AppendUserMessageInput = {
  conversationId: ConversationId;
  text: string;
  clientMessageId?: string | null;
};

export type AppendAssistantMessageInput = {
  conversationId: ConversationId;
  text: string;
  clientMessageId: string;
  thoughts?: string | null;
  model?: string | null;
  finishReason?: FinishReason;
  inputTokenCount?: number | null;
  outputTokenCount?: number | null;
};

export type GenerateReplyInput = {
  conversationId: ConversationId;
  messages: Pick<Message, 'role' | 'text'>[];
  mode?: ChatMode;
  model?: string;
  signal?: AbortSignal;
};

export type GenerateReplyResult = {
  text: string;
  model: string;
  inputTokenCount: number | null;
  outputTokenCount: number | null;
  finishReason: FinishReason;
};

export type CreateAttachmentInput = {
  conversationId: ConversationId;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

export type UploadTarget = {
  attachmentId: AttachmentId;
  storagePath: string;
};

export type ServiceErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not-found'
  | 'quota-exceeded'
  | 'invalid-input'
  | 'network'
  | 'provider';

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
