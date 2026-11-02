'use client';
import { useEffect, useState } from 'react';
import { getApps, initializeApp } from 'firebase/app';
import { collection, getFirestore, onSnapshot } from 'firebase/firestore';

export default function Page() {
  const [status, setStatus] = useState('Loading');
  useEffect(() => {
    const app = getApps()[0] ?? initializeApp({ apiKey: 'demo-api-key', projectId: 'demo-next-rewrite' });
    return onSnapshot(collection(getFirestore(app), 'items'), () => setStatus('Listening'));
  }, []);
  return <p id="items-status">{status}</p>;
}
