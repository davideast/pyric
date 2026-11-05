// What a user adds to the create-pyric web template as the app grows: email
// accounts next to Google sign-in, posts with fields to query, and listeners
// on parts of the list. The scenario copies this file into the scaffolded
// project's src/ and calls installSoak from the template's own main.ts, with
// its Auth and Firestore handles, so every call goes through the same SDK
// the page renders with.
import type { Auth } from 'firebase/auth';
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import type { Firestore, Unsubscribe } from 'firebase/firestore';
import { collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, query, setDoc, updateDoc, where } from 'firebase/firestore';

/** The fields the soak compares. A post the template's form adds has no `n` or `tag`. */
interface PostFields {
  title: string;
  n: number | null;
  tag: string | null;
}

interface ListenerState {
  ids: string[] | null;
  error: string | null;
}

function fields(data: Record<string, unknown> | undefined): PostFields | null {
  if (data === undefined) return null;
  return {
    title: String(data.title ?? ''),
    n: typeof data.n === 'number' ? data.n : null,
    tag: typeof data.tag === 'string' ? data.tag : null,
  };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : String(error);
}

export function installSoak(auth: Auth, db: Firestore): void {
  const listeners = new Map<string, { stop: Unsubscribe; state: ListenerState }>();

  const uid = (): string => {
    const user = auth.currentUser;
    if (user === null) throw new Error('no user is signed in');
    return user.uid;
  };
  const posts = () => collection(db, 'users', uid(), 'posts');

  const soak = {
    async authSettled(): Promise<string | null> {
      await auth.authStateReady();
      return auth.currentUser?.uid ?? null;
    },
    currentUid: (): string | null => auth.currentUser?.uid ?? null,
    async signUp(email: string, password: string): Promise<string> {
      return (await createUserWithEmailAndPassword(auth, email, password)).user.uid;
    },
    async signIn(email: string, password: string): Promise<string> {
      return (await signInWithEmailAndPassword(auth, email, password)).user.uid;
    },
    signOut: (): Promise<void> => signOut(auth),
    setPost: (id: string, data: { title: string; n: number; tag: string }): Promise<void> =>
      setDoc(doc(posts(), id), { ...data, uid: uid() }),
    updatePost: (id: string, patch: { n: number; tag: string }): Promise<void> => updateDoc(doc(posts(), id), patch),
    deletePost: (id: string): Promise<void> => deleteDoc(doc(posts(), id)),
    async getPost(id: string): Promise<PostFields | null> {
      return fields((await getDoc(doc(posts(), id))).data());
    },
    async allPosts(): Promise<Record<string, PostFields>> {
      const snap = await getDocs(posts());
      return Object.fromEntries(snap.docs.map((d) => [d.id, fields(d.data())!]));
    },
    async idsWithTag(tag: string): Promise<string[]> {
      const snap = await getDocs(query(posts(), where('tag', '==', tag)));
      return snap.docs.map((d) => d.id).sort();
    },
    async idsWithTitle(title: string): Promise<string[]> {
      const snap = await getDocs(query(posts(), where('title', '==', title)));
      return snap.docs.map((d) => d.id).sort();
    },
    /** Writes into another user's posts, which the template's rules deny. Returns the error code, or `allowed`. */
    async writeAs(otherUid: string, id: string): Promise<string> {
      try {
        await setDoc(doc(db, 'users', otherUid, 'posts', id), { title: 'not mine', n: 0, tag: 'a', uid: otherUid });
        return 'allowed';
      } catch (error) {
        return errorCode(error);
      }
    },
    listen(key: string, tag: string): void {
      const state: ListenerState = { ids: null, error: null };
      const stop = onSnapshot(
        query(posts(), where('tag', '==', tag)),
        (snap) => { state.ids = snap.docs.map((d) => d.id).sort(); },
        (error) => { state.error = errorCode(error); },
      );
      listeners.set(key, { stop, state });
    },
    unlisten(key: string): void {
      listeners.get(key)?.stop();
      listeners.delete(key);
    },
    unlistenAll(): void {
      for (const listener of listeners.values()) listener.stop();
      listeners.clear();
    },
    listenerStates(): Record<string, ListenerState> {
      return Object.fromEntries([...listeners].map(([key, listener]) => [key, { ...listener.state }]));
    },
  };
  (globalThis as { soak?: typeof soak }).soak = soak;
}
