import {
  addDoc,
  collection,
  getDocs,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  updateDoc,
  where,
  writeBatch,
  type Query,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
} from 'firebase/firestore';
import { auth, db } from '../firebase/app';
import {
  asConversationId,
  type Conversation,
  type ConversationDocument,
  type CreateConversationInput,
  type MessageDocument,
  type Page,
  type PageOptions,
  ServiceError,
} from '../firebase/types';
import { clampPageSize, mapFirestoreError, requireUid } from './firestore-helpers';

const allowedModels = new Set(['gemini-2.5-flash']);
const cleanTitle = (title: string): string => title.trim().slice(0, 120) || 'New conversation';

const toConversation = (snapshot: QueryDocumentSnapshot): Conversation => ({
  id: asConversationId(snapshot.id),
  ...(snapshot.data() as ConversationDocument),
});

const conversationQuery = (uid: string, pageSize: number) =>
  query(collection(db, 'conversations'), where('ownerUid', '==', uid), orderBy('updatedAt', 'desc'), limit(pageSize));
const messageCollection = (conversationId: Conversation['id']) => collection(db, 'conversations', conversationId, 'messages');

export class ConversationService {
  async list(options: PageOptions = {}): Promise<Page<Conversation>> {
    const uid = requireUid(auth.currentUser?.uid);
    const pageSize = clampPageSize(options.pageSize);
    try {
      const constraints = [where('ownerUid', '==', uid), orderBy('updatedAt', 'desc'), limit(pageSize)];
      const snapshot = await getDocs(
        options.cursor
          ? query(collection(db, 'conversations'), constraints[0], constraints[1], startAfter(options.cursor), constraints[2])
          : query(collection(db, 'conversations'), ...constraints),
      );
      return { items: snapshot.docs.map(toConversation), nextCursor: snapshot.docs.at(-1) ?? null };
    } catch (error) {
      throw mapFirestoreError(error);
    }
  }

  observeList(callback: (conversations: Conversation[]) => void, options: PageOptions = {}): () => void {
    const uid = requireUid(auth.currentUser?.uid);
    const pageSize = clampPageSize(options.pageSize);
    return onSnapshot(conversationQuery(uid, pageSize), (snapshot) => callback(snapshot.docs.map(toConversation)));
  }

  async create(input: CreateConversationInput = {}): Promise<Conversation['id']> {
    const uid = requireUid(auth.currentUser?.uid);
    const model = input.model ?? 'gemini-2.5-flash';
    if (!allowedModels.has(model)) throw new ServiceError('invalid-input', 'Unsupported model');
    try {
      const reference = await addDoc(collection(db, 'conversations'), {
        ownerUid: uid,
        title: cleanTitle(input.title ?? ''),
        model,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastMessageAt: null,
        messageCount: 0,
        archivedAt: null,
        attachmentCount: 0,
        schemaVersion: 1,
      });
      return asConversationId(reference.id);
    } catch (error) {
      throw mapFirestoreError(error);
    }
  }

  async get(id: Conversation['id']): Promise<Conversation | null> {
    requireUid(auth.currentUser?.uid);
    try {
      const snapshot = await getDoc(doc(db, 'conversations', id));
      return snapshot.exists() ? ({ id, ...(snapshot.data() as ConversationDocument) } satisfies Conversation) : null;
    } catch (error) {
      throw mapFirestoreError(error);
    }
  }

  async updateTitle(id: Conversation['id'], title: string): Promise<void> {
    requireUid(auth.currentUser?.uid);
    if (!title.trim() || title.length > 120) throw new ServiceError('invalid-input', 'Title must be 1–120 characters');
    try {
      await updateDoc(doc(db, 'conversations', id), { title: cleanTitle(title), updatedAt: serverTimestamp() });
    } catch (error) {
      throw mapFirestoreError(error);
    }
  }

  async archive(id: Conversation['id']): Promise<void> {
    requireUid(auth.currentUser?.uid);
    try {
      await updateDoc(doc(db, 'conversations', id), { archivedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    } catch (error) {
      throw mapFirestoreError(error);
    }
  }

  async delete(id: Conversation['id']): Promise<void> {
    const uid = requireUid(auth.currentUser?.uid);
    try {
      let cursor: QueryDocumentSnapshot | null = null;
      while (true) {
        const messageQuery = (cursor
          ? query(messageCollection(id), where('ownerUid', '==', uid), orderBy('createdAt'), startAfter(cursor), limit(100))
          : query(messageCollection(id), where('ownerUid', '==', uid), orderBy('createdAt'), limit(100))) as Query<MessageDocument>;
        const snapshots: QuerySnapshot<MessageDocument> = await getDocs(messageQuery);
        if (!snapshots.docs.length) break;
        const batch = writeBatch(db);
        snapshots.docs.forEach((snapshot: QueryDocumentSnapshot<MessageDocument>) => batch.delete(snapshot.ref));
        await batch.commit();
        cursor = snapshots.docs.at(-1) ?? null;
        if (snapshots.docs.length < 100) break;
      }

      const batch = writeBatch(db);
      batch.delete(doc(db, 'conversations', id));
      await batch.commit();
    } catch (error) {
      throw mapFirestoreError(error);
    }
  }

  observe(id: Conversation['id'], callback: (value: Conversation) => void): () => void {
    requireUid(auth.currentUser?.uid);
    return onSnapshot(doc(db, 'conversations', id), (snapshot) => {
      if (snapshot.exists()) callback({ id, ...(snapshot.data() as ConversationDocument) });
    });
  }
}
