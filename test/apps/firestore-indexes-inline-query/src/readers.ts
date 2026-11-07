import {
  collection,
  count,
  getAggregateFromServer,
  getCountFromServer,
  onSnapshot,
  orderBy,
  query,
  sum,
  where,
  type QuerySnapshot,
} from 'firebase/firestore';
import { db } from './db';

export function watchOpenTasks(listId: string, onChange: (snapshot: QuerySnapshot) => void) {
  return onSnapshot(query(collection(db, 'tasks'), where('listId', '==', listId), orderBy('dueAt', 'asc')), onChange);
}

export async function countRecentEvents(roomId: string, since: number) {
  return getCountFromServer(query(collection(db, 'events'), where('roomId', '==', roomId), where('at', '>=', since)));
}

export async function totalPaidOrders(storeId: string) {
  return getAggregateFromServer(
    query(collection(db, 'orders'), where('storeId', '==', storeId), where('status', '==', 'paid'), orderBy('paidAt', 'desc')),
    { total: sum('amount'), orders: count() },
  );
}
