import type { LocalSandbox } from 'pyric/sandbox';
import { getAuth, signInWithEmailAndPassword, signInWithPopup, signOut, onAuthStateChanged, GoogleAuthProvider, type Auth, type User } from 'pyric/auth';
import { getFirestore, collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, type Firestore } from 'pyric/firestore';
import { getStorageSandbox, ref as storageRef, uploadBytes, getDownloadURL, type FirebaseStorage } from 'pyric/storage';
import { getDatabase, ref as dbRef, onValue, type Database } from 'pyric/database';
import { getAI, getGenerativeModel, type AI } from 'pyric/ai';
import { getMessaging, getToken, onMessage, type Messaging } from 'pyric/messaging';
import { STORAGE_RULES_SOURCE } from '../sandbox/sandbox-driver';

export interface TaskItem {
  id: string;
  title: string;
  completed: boolean;
  category: string;
  priority: 'Low' | 'Medium' | 'High';
  owner: string;
  attachmentUrl?: string;
  updatedAt?: number;
}

export interface ActivityEvent {
  user: string;
  action: string;
  timestamp: number;
}

export class TaskApplicationService {
  readonly auth: Auth;
  readonly db: Firestore;
  readonly storage: FirebaseStorage;
  readonly rtdb: Database;
  readonly ai: AI;
  readonly messaging: Messaging;

  private activeFcmToken: string | null = null;
  private unsubscribeTodos: (() => void) | null = null;

  constructor(sandbox: LocalSandbox) {
    this.auth = getAuth(sandbox);
    this.db = getFirestore(sandbox);
    this.storage = getStorageSandbox(sandbox, { rules: STORAGE_RULES_SOURCE });
    this.rtdb = getDatabase(sandbox);
    this.ai = getAI(sandbox);
    this.messaging = getMessaging(sandbox);
  }

  onAuthChange(callback: (user: User | null) => void): () => void {
    return onAuthStateChanged(this.auth, callback);
  }

  getCurrentUser(): User | null {
    return this.auth.currentUser;
  }

  async signInEmail(email: string, pass: string): Promise<void> {
    await signInWithEmailAndPassword(this.auth, email, pass);
  }

  async signInGoogle(): Promise<void> {
    await signInWithPopup(this.auth, new GoogleAuthProvider());
  }

  async signInGuest(email = 'guest@example.com', pass = 'guest12345'): Promise<void> {
    await signInWithEmailAndPassword(this.auth, email, pass);
  }

  async signOutUser(): Promise<void> {
    await signOut(this.auth);
  }

  subscribeToTasks(
    onData: (tasks: TaskItem[]) => void, 
    onError?: (err: Error) => void
  ): () => void {
    if (this.unsubscribeTodos) {
      this.unsubscribeTodos();
      this.unsubscribeTodos = null;
    }
    const colRef = collection(this.db, 'todos');
    this.unsubscribeTodos = onSnapshot(
      colRef,
      (snapshot: any) => {
        const items: TaskItem[] = snapshot.docs.map((docSnap: any) => {
          const data = docSnap.data() || {};
          return {
            id: docSnap.id,
            title: String(data.title || 'Untitled Task'),
            completed: Boolean(data.completed),
            category: String(data.category || 'Work'),
            priority: (data.priority as 'Low' | 'Medium' | 'High') || 'Medium',
            owner: String(data.owner || 'anonymous'),
            attachmentUrl: data.attachmentUrl ? String(data.attachmentUrl) : undefined,
            updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
          };
        });
        items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        onData(items);
      },
      (err: any) => {
        if (onError) onError(err as Error);
      }
    );
    return () => {
      if (this.unsubscribeTodos) {
        this.unsubscribeTodos();
        this.unsubscribeTodos = null;
      }
    };
  }

  async addTask(title: string, category: string, priority: 'Low' | 'Medium' | 'High', attachmentUrl?: string): Promise<string> {
    const user = this.auth.currentUser;
    const owner = user ? (user.uid || 'anonymous') : 'anonymous';
    const id = 'task-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const taskDoc = doc(this.db, 'todos', id);
    const payload: Record<string, unknown> = {
      title: title.trim(),
      completed: false,
      category,
      priority,
      owner,
      updatedAt: Date.now(),
    };
    if (attachmentUrl) {
      payload.attachmentUrl = attachmentUrl;
    }
    await setDoc(taskDoc, payload);
    return id;
  }

  async updateTaskTitle(id: string, newTitle: string, currentOwner: string): Promise<void> {
    const taskDoc = doc(this.db, 'todos', id);
    await updateDoc(taskDoc, { title: newTitle.trim(), owner: currentOwner, updatedAt: Date.now() });
  }

  async toggleTaskStatus(id: string, newStatus: boolean, currentOwner: string): Promise<void> {
    const taskDoc = doc(this.db, 'todos', id);
    await updateDoc(taskDoc, { completed: newStatus, owner: currentOwner, updatedAt: Date.now() });
  }

  async removeTask(id: string): Promise<void> {
    const taskDoc = doc(this.db, 'todos', id);
    await deleteDoc(taskDoc);
  }

  async clearCompletedTasks(tasks: TaskItem[]): Promise<void> {
    const completed = tasks.filter((t) => t.completed);
    for (const item of completed) {
      await this.removeTask(item.id);
    }
  }

  async uploadTaskAttachment(file: File): Promise<string> {
    const user = this.auth.currentUser;
    const uid = user ? user.uid : 'anonymous';
    const filename = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const fileRef = storageRef(this.storage, `attachments/${uid}/${filename}`);
    const res = await uploadBytes(fileRef, file);
    return getDownloadURL(res.ref);
  }

  async generateTaskSuggestions(promptText: string): Promise<{ items: Array<{ title: string; category: string; priority: string }>; raw: string }> {
    const model = getGenerativeModel(this.ai, { model: 'gemini-2.5-pro' });
    const res = await model.generateContent(promptText);
    const raw = res.response.text();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('Expected JSON array from AI model output.');
    }
    return { items: parsed, raw };
  }

  async requestPushToken(): Promise<string> {
    const token = await getToken(this.messaging);
    this.activeFcmToken = token;
    return token;
  }

  getActiveToken(): string | null {
    return this.activeFcmToken;
  }

  clearPushToken(): void {
    this.activeFcmToken = null;
  }

  onPushMessage(handler: (payload: any) => void): () => void {
    return onMessage(this.messaging, handler);
  }

  subscribeToPresence(onData: (uids: string[]) => void, onError?: (err: Error) => void): () => void {
    const presenceRef = dbRef(this.rtdb, 'presence');
    return onValue(
      presenceRef,
      (snap) => {
        const val = (snap.val() || {}) as Record<string, any>;
        const uids = Object.keys(val).filter((k) => val[k] && val[k].state === 'online');
        onData(uids);
      },
      ((err: Error) => {
        if (onError) onError(err);
      }) as any
    );
  }

  subscribeToActivityStream(onData: (events: ActivityEvent[]) => void, onError?: (err: Error) => void): () => void {
    const activityRef = dbRef(this.rtdb, 'activity_stream');
    return onValue(
      activityRef,
      (snap) => {
        const val = (snap.val() || {}) as Record<string, any>;
        const ids = Object.keys(val).sort().reverse().slice(0, 8);
        const events: ActivityEvent[] = ids.map((id) => ({
          user: val[id].user || 'Unknown',
          action: val[id].action || '',
          timestamp: typeof val[id].timestamp === 'number' ? val[id].timestamp : Date.now(),
        }));
        onData(events);
      },
      ((err: Error) => {
        if (onError) onError(err);
      }) as any
    );
  }
}
