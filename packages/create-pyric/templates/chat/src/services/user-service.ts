import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase/app';
import { asUserId, type AuthUser, type UserDocument, ServiceError } from '../firebase/types';
import { mapFirestoreError } from './firestore-helpers';

export class UserService {
  async provision(user: AuthUser): Promise<void> {
    try {
      const reference = doc(db, 'users', user.uid);
      if ((await getDoc(reference)).exists()) {
        await updateDoc(reference, {
          displayName: user.displayName,
          photoURL: user.photoURL,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(reference, {
          uid: user.uid,
          displayName: user.displayName,
          photoURL: user.photoURL,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          disabledAt: null,
        } as Partial<UserDocument>);
      }
    } catch (error) {
      throw mapFirestoreError(error);
    }
  }
}
