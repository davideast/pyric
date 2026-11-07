import { getDocs, orderBy, query, where } from 'firebase/firestore';
import { projectsOf } from './refs';

export async function recentProjects(ownerId: string) {
  return getDocs(query(projectsOf(ownerId), where('archived', '==', false), orderBy('updatedAt', 'desc')));
}
