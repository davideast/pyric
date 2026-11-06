// What the soak reads and calls in the page: the helpers soak-page.ts puts on
// `globalThis.soak`, the shapes they return, and the actions the script picks.

export interface Account { email: string; password: string | null; uid: string }
export interface Post { title: string; n: number | null; tag: string | null }
export interface ListenerState { ids: string[] | null; error: string | null }

/** `globalThis.soak` in the page. Each file that calls it in `page.evaluate` declares `soak` with this type. */
export interface SoakPage {
  authSettled(): Promise<string | null>;
  currentUid(): string | null;
  signUp(email: string, password: string): Promise<string>;
  signIn(email: string, password: string): Promise<string>;
  signOut(): Promise<void>;
  setPost(id: string, data: { title: string; n: number; tag: string }): Promise<void>;
  updatePost(id: string, patch: { n: number; tag: string }): Promise<void>;
  deletePost(id: string): Promise<void>;
  getPost(id: string): Promise<Post | null>;
  allPosts(): Promise<Record<string, Post>>;
  idsWithTag(tag: string): Promise<string[]>;
  idsWithTitle(title: string): Promise<string[]>;
  writeAs(otherUid: string, id: string): Promise<string>;
  listen(key: string, tag: string): void;
  unlisten(key: string): void;
  unlistenAll(): void;
  listenerStates(): Record<string, ListenerState>;
}

export type ActionName =
  | 'sign up' | 'sign in' | 'sign in with Google' | 'sign out'
  | 'add post in the form' | 'set post' | 'update post' | 'delete post' | 'read post' | 'query by tag'
  | 'write as another user' | 'add listener' | 'remove listener'
  | 'reload' | 'second tab' | 'restart dev server' | 'pause';

export const TAGS = ['a', 'b', 'c'] as const;
/** Email accounts. */
export const MAX_ACCOUNTS = 12;
/**
 * Google accounts, which the sandbox's dialog lists. Set so a long run lists
 * 51 or more, the state in which the first full hour's Google sign-in did not
 * finish (action 5838, SOAK_SEED=20261104), a failure not yet explained.
 */
export const MAX_GOOGLE_ACCOUNTS = 64;
export const MANY_POSTS = 15;
export const MAX_LISTENERS = 4;
export const ACTIONS_BETWEEN_RELOADS = 120;
/** How long one call into the page or the dev server gets. */
export const ACTION_LIMIT_MS = 30_000;
/** How long the page gets to show the result of an action. */
export const SETTLE_MS = 10_000;
export const PROJECT = 'my-web';
