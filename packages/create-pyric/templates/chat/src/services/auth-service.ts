import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { auth } from '../firebase/app';
import { asUserId, type AuthUser } from '../firebase/types';

const toAuthUser = (user: User | null): AuthUser | null =>
  user
    ? {
        uid: asUserId(user.uid),
        displayName: user.displayName,
        email: user.email,
        photoURL: user.photoURL,
        emailVerified: user.emailVerified,
      }
    : null;

export class FirebaseAuthService {
  currentUser(): AuthUser | null {
    return toAuthUser(auth.currentUser);
  }

  observe(callback: (user: AuthUser | null) => void): () => void {
    return onAuthStateChanged(auth, (user) => callback(toAuthUser(user)));
  }

  async signIn(): Promise<AuthUser> {
    const result = await signInWithPopup(auth, new GoogleAuthProvider());
    const user = toAuthUser(result.user);
    if (!user) throw new Error('Firebase returned no signed-in user');
    return user;
  }

  async signOut(): Promise<void> {
    await firebaseSignOut(auth);
  }
}
