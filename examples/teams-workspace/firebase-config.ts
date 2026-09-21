export const firebaseConfig = {
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "demo",
  authDomain:
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "orbit-demo.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "orbit-demo",
  databaseURL:
    import.meta.env.VITE_FIREBASE_DATABASE_URL ??
    "https://orbit-demo-default-rtdb.firebaseio.com",
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "orbit-demo.appspot.com",
};
