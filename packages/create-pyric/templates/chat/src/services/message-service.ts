import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  where,
} from 'firebase/firestore';
import { push, ref, serverTimestamp as rtdbServerTimestamp } from 'firebase/database';
import { auth, db, rtdb } from '../firebase/app';
import { asMessageId, type AppendAssistantMessageInput, type AppendUserMessageInput, type Message, type MessageDocument, type Page, type PageOptions, ServiceError } from '../firebase/types';
import { clampPageSize, mapFirestoreError, requireUid } from './firestore-helpers';

const toMessage = (snapshot: { id: string; data: () => unknown }): Message => ({
  id: asMessageId(snapshot.id),
  ...(snapshot.data() as MessageDocument),
});

const messageCollection = (conversationId: string) => collection(db, 'conversations', conversationId, 'messages');

export class MessageService {
  async list(conversationId: string, options: PageOptions = {}): Promise<Page<Message>> {
    const uid = requireUid(auth.currentUser?.uid);
    const pageSize = clampPageSize(options.pageSize);
    try {
      const constraints = [where('ownerUid', '==', uid), orderBy('createdAt', 'desc'), limit(pageSize)];
      const messageQuery = options.cursor
        ? query(messageCollection(conversationId), constraints[0], constraints[1], startAfter(options.cursor), constraints[2])
        : query(messageCollection(conversationId), ...constraints);
      const snapshot = await getDocs(messageQuery);
      return { items: snapshot.docs.map(toMessage), nextCursor: snapshot.docs.at(-1) ?? null };
    } catch (error) {
      throw mapFirestoreError(error);
    }
  }

  async appendUserMessage(input: AppendUserMessageInput): Promise<Message['id']> {
    const uid = requireUid(auth.currentUser?.uid);
    const text = input.text.trim();
    if (!text || text.length > 20_000) throw new ServiceError('invalid-input', 'Message must be 1–20,000 characters');
    try {
      const reference = await addDoc(messageCollection(input.conversationId), {
        ownerUid: uid,
        conversationId: input.conversationId,
        role: 'user',
        text,
        createdAt: serverTimestamp(),
        clientMessageId: input.clientMessageId ?? null,
        thoughts: null,
        model: null,
        finishReason: null,
        inputTokenCount: null,
        outputTokenCount: null,
        schemaVersion: 1,
      });
      return asMessageId(reference.id);
    } catch (error) {
      throw mapFirestoreError(error);
    }
  }

  async appendAssistantMessage(input: AppendAssistantMessageInput): Promise<Message['id']> {
    const uid = requireUid(auth.currentUser?.uid);
    const text = input.text.trim();
    if (!text || text.length > 20_000) throw new ServiceError('invalid-input', 'Message must be 1–20,000 characters');
    try {
      const reference = await addDoc(messageCollection(input.conversationId), {
        ownerUid: uid,
        conversationId: input.conversationId,
        role: 'assistant',
        text,
        createdAt: serverTimestamp(),
        clientMessageId: input.clientMessageId,
        thoughts: input.thoughts?.trim() || null,
        model: input.model ?? 'gemini-2.5-flash',
        finishReason: input.finishReason ?? 'stop',
        inputTokenCount: input.inputTokenCount ?? null,
        outputTokenCount: input.outputTokenCount ?? null,
        schemaVersion: 1,
      });
      // Fan out a backend notification request now that the reply is persisted.
      // Best-effort and fire-and-forget: the message is already saved, so a
      // notify failure must not surface as an append failure.
      void this.notifyAssistantReply(uid, input.conversationId, text);
      return asMessageId(reference.id);
    } catch (error) {
      throw mapFirestoreError(error);
    }
  }

  /**
   * Write `/notify/{uid}/{pushId}` in Realtime Database. The create fires the
   * `notifyOnAssistantReply` Cloud Function, which reads the owner's saved
   * `fcmToken` (admin SDK) and sends the OS notification through Cloud
   * Messaging — routed to a hidden tab's background handler.
   */
  private async notifyAssistantReply(uid: string, conversationId: string, text: string): Promise<void> {
    try {
      const conversation = await getDoc(doc(db, 'conversations', conversationId));
      const title = (conversation.data()?.title as string | undefined) ?? 'PyChat';
      await push(ref(rtdb, `notify/${uid}`), {
        title,
        body: text.slice(0, 80),
        conversationId,
        createdAt: rtdbServerTimestamp(),
      });
    } catch {
      // The reply is already persisted; the notification is non-critical.
    }
  }

  observeRecent(conversationId: string, callback: (messages: Message[]) => void): () => void {
    const uid = requireUid(auth.currentUser?.uid);
    const messageQuery = query(messageCollection(conversationId), where('ownerUid', '==', uid), orderBy('createdAt', 'desc'), limit(50));
    return onSnapshot(messageQuery, (snapshot) => callback(snapshot.docs.map(toMessage).reverse()));
  }
}
