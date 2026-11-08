import { getAuth } from 'firebase/auth';
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  equalTo,
  get,
  getDatabase,
  orderByChild,
  query as dbQuery,
  ref as dbRef,
  set,
} from 'firebase/database';
import {
  getStorage,
  ref as storageRef,
  uploadString,
} from 'firebase/storage';

export async function syncWorkspace() {
  const auth = getAuth();
  const uid = auth.currentUser!.uid;

  const db = getFirestore();
  await setDoc(doc(db, 'orgs/acme/items', 'item-1'), {
    ownerId: uid,
    title: 'Quarterly summary',
  });
  await updateDoc(doc(db, 'orgs/acme/items', 'item-1'), {
    title: 'Revised summary',
  });
  await getDocs(collection(db, 'orgs/acme/items'));

  const rtdb = getDatabase();
  await set(dbRef(rtdb, `orgs/acme/presence/${uid}`), {
    status: 'online',
    role: 'editor',
  });
  await get(
    dbQuery(
      dbRef(rtdb, 'orgs/acme/presence'),
      orderByChild('role'),
      equalTo('editor'),
    ),
  );

  const storage = getStorage();
  await uploadString(
    storageRef(storage, 'orgs/acme/attachments/notes.txt'),
    'draft notes',
    'raw',
    {
      contentType: 'text/plain',
      customMetadata: { ownerId: uid },
    },
  );
}
