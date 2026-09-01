export interface RuntimeIdentity {
  uid: string;
  email?: string | null;
  displayName?: string | null;
}

export function projectRuntimeIdentity(user: RuntimeIdentity | null | undefined): RuntimeIdentity | null {
  if (!user) return null;
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
  };
}
