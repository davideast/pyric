import type { AuthUserRecord } from 'pyric/auth';

export interface RuntimeIdentity {
  uid: string;
  email?: string | null;
  displayName?: string | null;
}

/** The chip's complete identity integration seam, passed intact through mounting. */
export interface RuntimeIdentityBindings {
  listUsers(): Promise<AuthUserRecord[]> | AuthUserRecord[];
  switchUser(uid: string): Promise<void> | void;
  signOut(): Promise<void> | void;
  openCreateUser(): void;
  getCurrentUser(): RuntimeIdentity | null;
  subscribeAuth(listener: (user: RuntimeIdentity | null) => void): () => void;
}

export function projectRuntimeIdentity(user: RuntimeIdentity | null | undefined): RuntimeIdentity | null {
  if (!user) return null;
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
  };
}
