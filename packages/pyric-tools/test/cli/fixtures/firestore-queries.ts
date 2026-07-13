import { collection, orderBy, query, where } from 'firebase/firestore';

export function openOrders(db: unknown) {
  const q = query(
    collection(db as never, 'orders'),
    where('status', '==', 'open'),
    orderBy('createdAt', 'desc'),
  );
  return q;
}
