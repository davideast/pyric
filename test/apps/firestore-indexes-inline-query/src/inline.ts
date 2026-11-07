import { collectionGroup, getDocs, orderBy, query, where } from 'firebase/firestore';
import { db } from './db';

export async function recentProjects(ownerId: string) {
  return getDocs(query(collectionGroup(db, 'projects'), where('ownerId', '==', ownerId), orderBy('updatedAt', 'desc')));
}
