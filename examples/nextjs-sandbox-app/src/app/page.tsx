'use client';

import React, { useEffect, useState, type FormEvent, type CSSProperties } from 'react';
import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  GoogleAuthProvider,
  type User,
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  onSnapshot,
  addDoc,
  serverTimestamp,
  type DocumentData,
} from 'firebase/firestore';

interface PostRecord {
  id: string;
  title: string;
  uid: string;
}

interface ServerStatusResponse {
  status: string;
  environment?: string;
  count?: number;
  details?: string;
}

const DEFAULT_FIREBASE_CONFIG = {
  apiKey: 'demo-api-key',
  authDomain: 'demo-nextjs-app.firebaseapp.com',
  projectId: 'demo-nextjs-app',
};

function resolveClientFirebaseApp(): FirebaseApp {
  const existingApps = getApps();
  if (existingApps.length > 0) {
    return getApp();
  }
  return initializeApp(DEFAULT_FIREBASE_CONFIG);
}

function resolveUserDisplayLabel(currentUser: User): string {
  if (currentUser.displayName !== null && currentUser.displayName !== '') {
    return `Signed in as ${currentUser.displayName}`;
  }
  if (currentUser.email !== null && currentUser.email !== '') {
    return `Signed in as ${currentUser.email}`;
  }
  return `Signed in as ${currentUser.uid}`;
}

export default function HomePage(): React.JSX.Element {
  const [activeUser, setActiveUser] = useState<User | null>(null);
  const [postsList, setPostsList] = useState<PostRecord[]>([]);
  const [newPostTitle, setNewPostTitle] = useState<string>('');
  const [authStatusText, setAuthStatusText] = useState<string>('Checking authentication state...');
  const [backendApiStatusText, setBackendApiStatusText] = useState<string>('Connecting to Server API...');

  useEffect(() => {
    const clientApp = resolveClientFirebaseApp();
    const authService = getAuth(clientApp);
    const firestoreDb = getFirestore(clientApp);

    const unsubscribeAuth = onAuthStateChanged(authService, (userState) => {
      setActiveUser(userState);
      if (userState !== null) {
        const userLabel = resolveUserDisplayLabel(userState);
        setAuthStatusText(userLabel);
      } else {
        setAuthStatusText('Signed out');
      }
    });

    const postsCollectionRef = collection(firestoreDb, 'posts');
    const unsubscribeSnapshot = onSnapshot(postsCollectionRef, (snapshot) => {
      const currentPosts: PostRecord[] = [];
      for (const documentSnapshot of snapshot.docs) {
        const rawData = documentSnapshot.data() as DocumentData;
        const documentTitle = typeof rawData.title === 'string' ? rawData.title : 'Untitled Post';
        const authorId = typeof rawData.uid === 'string' ? rawData.uid : 'anonymous';
        const postEntry: PostRecord = {
          id: documentSnapshot.id,
          title: documentTitle,
          uid: authorId,
        };
        currentPosts.push(postEntry);
      }
      setPostsList(currentPosts);

      fetch('/api/status')
        .then(async (response) => {
          const payload = (await response.json().catch(() => ({ status: 'error', details: `HTTP ${response.status}` }))) as ServerStatusResponse;
          if (!response.ok) {
            const failureDetail = payload.details !== undefined ? payload.details : `HTTP ${response.status}`;
            throw new Error(failureDetail);
          }
          return payload;
        })
        .then((payload) => {
          if (payload.status === 'ok' && payload.environment !== undefined && payload.count !== undefined) {
            setBackendApiStatusText(`Server-Side Admin API Runtime: ${payload.environment} (${payload.count} database records)`);
          } else {
            const failureDetail = payload.details !== undefined ? payload.details : 'Unknown error';
            setBackendApiStatusText(`Server-Side Admin API reported an error: ${failureDetail}`);
          }
        })
        .catch((err: unknown) => {
          const failureDetail = err instanceof Error ? err.message : String(err);
          setBackendApiStatusText(`Server-Side Admin API unavailable (${failureDetail})`);
        });
    });

    return () => {
      unsubscribeAuth();
      unsubscribeSnapshot();
    };
  }, []);

  const onSignInClicked = async () => {
    const clientApp = resolveClientFirebaseApp();
    const authService = getAuth(clientApp);
    const googleProvider = new GoogleAuthProvider();
    await signInWithPopup(authService, googleProvider);
  };

  const onSignOutClicked = async () => {
    const clientApp = resolveClientFirebaseApp();
    const authService = getAuth(clientApp);
    await signOut(authService);
  };

  const onPostFormSubmitted = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clientApp = resolveClientFirebaseApp();
    const authService = getAuth(clientApp);
    const firestoreDb = getFirestore(clientApp);
    const currentUser = authService.currentUser;

    const trimmedTitle = newPostTitle.trim();
    if (trimmedTitle === '') {
      return;
    }

    try {
      const postsCollectionRef = collection(firestoreDb, 'posts');
      const authorId = currentUser !== null ? currentUser.uid : 'anonymous';
      await addDoc(postsCollectionRef, {
        title: trimmedTitle,
        uid: authorId,
        createdAt: serverTimestamp(),
      });
      setNewPostTitle('');
    } catch (writeError) {
      const errorCode = (writeError as { code?: string }).code;
      const displayMessage = errorCode !== undefined ? errorCode : String(writeError);
      if (currentUser !== null) {
        setAuthStatusText(`Write operation failed: ${displayMessage}`);
      } else {
        setAuthStatusText('Denied by security rules (signed out) — check the Traffic tab in Pyric Studio.');
      }
    }
  };

  const buttonStyle: CSSProperties = { padding: '0.4rem 0.9rem', cursor: 'pointer' };
  const inputStyle: CSSProperties = { flex: 1, padding: '0.4rem 0.6rem' };
  const formStyle: CSSProperties = { display: 'flex', gap: '0.5rem', margin: '1rem 0' };

  return (
    <main>
      <h1>nextjs-sandbox-app</h1>
      <p id="auth-status" style={{ color: '#555', fontWeight: 'bold' }}>
        {authStatusText}
      </p>
      <p id="api-status" style={{ color: '#0066cc', fontSize: '0.9rem', marginBottom: '1rem' }}>
        {backendApiStatusText}
      </p>

      {activeUser === null ? (
        <button id="sign-in-button" type="button" onClick={onSignInClicked} style={buttonStyle}>
          Sign in with Google
        </button>
      ) : (
        <button id="sign-out-button" type="button" onClick={onSignOutClicked} style={buttonStyle}>
          Sign out
        </button>
      )}

      <form id="add-post-form" onSubmit={onPostFormSubmitted} style={formStyle}>
        <input
          id="post-title-input"
          type="text"
          value={newPostTitle}
          onChange={(event) => setNewPostTitle(event.target.value)}
          placeholder="Post title"
          required
          style={inputStyle}
        />
        <button id="submit-post-button" type="submit" style={buttonStyle}>
          Add post
        </button>
      </form>

      <h2>Posts</h2>
      {postsList.length === 0 ? (
        <p style={{ color: '#888', fontStyle: 'italic' }}>No posts yet in database.</p>
      ) : (
        <ul id="posts-list" style={{ paddingLeft: '1.2rem' }}>
          {postsList.map((postItem) => (
            <li key={postItem.id}>
              <strong>{postItem.title}</strong>{' '}
              <span style={{ color: '#777', fontSize: '0.8rem' }}>(by {postItem.uid})</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
