import { onValue, ref, serverTimestamp, set } from 'firebase/database';
import { auth, rtdb } from '../firebase/app';
import { asUserId, type AuthUser, type PresenceEntry, type PresenceRecord, ServiceError } from '../firebase/types';
import { requireUid } from './firestore-helpers';

const mapRtdbError = (error: unknown): ServiceError => {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  if (code.includes('PERMISSION_DENIED') || code.includes('permission-denied')) {
    return new ServiceError('forbidden', 'The presence write is not allowed', error);
  }
  return new ServiceError('network', 'The Realtime Database operation failed', error);
};

const presenceRef = (uid: string) => ref(rtdb, `presence/${uid}`);

const toEntry = (uid: string, record: Partial<PresenceRecord> | null): PresenceEntry | null =>
  record && (record.state === 'online' || record.state === 'offline')
    ? { uid: asUserId(uid), state: record.state, displayName: record.displayName ?? null }
    : null;

export class PresenceService {
  /**
   * Publish the signed-in user as online. The initial `set` creates
   * `/presence/{uid}` the first time a user comes online, which is what
   * fires the `onPresenceOnline` Cloud Function.
   *
   * In a production build we also register a real `onDisconnect` so the node
   * flips to offline when the socket drops. `onDisconnect` is not part of the
   * sandbox's Realtime Database surface yet (RTDB support is incomplete), so
   * under `vite dev` we rely on the explicit `goOffline` writes below.
   */
  async goOnline(user: AuthUser): Promise<void> {
    const uid = requireUid(user.uid);
    try {
      const reference = presenceRef(uid);
      if (import.meta.env.PROD) {
        const { onDisconnect } = await import('firebase/database');
        await onDisconnect(reference).set({ state: 'offline', displayName: user.displayName, at: serverTimestamp() });
      }
      await set(reference, { state: 'online', displayName: user.displayName, at: serverTimestamp() });
    } catch (error) {
      throw mapRtdbError(error);
    }
  }

  async goOffline(): Promise<void> {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try {
      await set(presenceRef(uid), { state: 'offline', displayName: auth.currentUser?.displayName ?? null, at: serverTimestamp() });
    } catch (error) {
      throw mapRtdbError(error);
    }
  }

  /** Observe every presence node; the callback receives the online members. */
  observe(callback: (online: PresenceEntry[]) => void): () => void {
    requireUid(auth.currentUser?.uid);
    return onValue(ref(rtdb, 'presence'), (snapshot) => {
      const entries: PresenceEntry[] = [];
      snapshot.forEach((child) => {
        const entry = toEntry(child.key ?? '', child.val() as Partial<PresenceRecord> | null);
        if (entry && entry.state === 'online') entries.push(entry);
      });
      callback(entries);
    });
  }
}
