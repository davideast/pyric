import { doc, getDoc, getFirestore, setDoc } from 'pyric/firestore';
import type { PyricExampleContext } from '../definition';

export async function run({ sandbox }: PyricExampleContext) {
  const db = getFirestore(sandbox.withAuth({ uid: 'ada' }));
  const note = doc(db, 'notes', 'first');

  await setDoc(note, {
    title: 'The sandbox is local',
    ownerId: 'ada',
  });

  const saved = await getDoc(note);
  return saved.data();
}
