import { getApp, getApps, initializeApp } from 'firebase/app';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'demo',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'demo.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'demo',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? 'demo',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? 'demo',
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
};

export const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(config);
export const firebaseConfig = config;
