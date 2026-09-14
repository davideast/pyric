/** Public Firestore data operations observed by the modular adapters. */
export const firestoreActivityCoverage = {
  service: 'firestore',
  read: ['getDoc', 'getDocs', 'getDocFromCache', 'getDocFromServer', 'getDocsFromCache', 'getDocsFromServer', 'getCountFromServer', 'getAggregateFromServer'],
  write: ['setDoc', 'updateDoc', 'deleteDoc', 'addDoc', 'writeBatch.commit', 'runTransaction'],
  listener: ['onSnapshot'],
  untrackedMethods: [],
} as const;
