/**
 * Scaffold template definition for Next.js (`npm create pyric -- --template nextjs`).
 */
import type { ScaffoldTemplate } from './templates.js';

const NEXTJS_CONFIG_MJS = `import { withPyric } from '@pyric/cli/next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

// Under development mode (\`pyric dev -- next dev\`), withPyric maps client-side
// firebase/* SDK imports to Pyric sandbox adapters via Webpack/Turbopack aliases,
// externalizes server-side firebase and firebase-admin imports for Node loader
// hooks (@pyric/cli/register), and proxies /__pyric/* bridge traffic.
// Under \`next build\` (mode production), withPyric acts as an identity passthrough,
// compiling canonical Firebase SDKs untouched with zero runtime overhead.
export default withPyric(nextConfig);
`;

const NEXTJS_TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
`;

const NEXTJS_ENV_EXAMPLE = `# Your real Firebase application configuration from the Firebase Console.
# UNUSED in local development under \`pyric dev\` (the Pyric sandbox stands in);
# USED by \`next build\` for production cloud builds. Next.js exposes environment
# variables prefixed with \`NEXT_PUBLIC_\` to client-side code in the browser.
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
`;

const NEXTJS_GITIGNORE = `# next.js
/.next/
/out/
/build/

# production
/build
/dist

# misc
.DS_Store
*.pem

# debug
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# local env files
.env*.local
.env
.env.pyric

# pyric session files
.pyric/

# vercel
.vercel

# typescript
*.tsbuildinfo
next-env.d.ts
`;

const NEXTJS_FIREBASE_JSON = `{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  }
}
`;

const NEXTJS_FIRESTORE_INDEXES = `{
  "indexes": [],
  "fieldOverrides": []
}
`;

const NEXTJS_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Owner-based security rules from line 1 — Pyric deploys and hot-reloads
    // this configuration into the local sandbox environment. These deploy as-is
    // to production Firebase instances.
    match /posts/{postId} {
      allow read: if true;
      allow create: if request.auth != null
                    && request.resource.data.uid == request.auth.uid;
      allow update, delete: if request.auth != null
                            && resource.data.uid == request.auth.uid;
    }

    // Default deny — require explicit authorization rules per collection.
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
`;

function buildRootLayout(projectName: string): string {
  return `import type { Metadata } from 'next';
import React from 'react';

export const metadata: Metadata = {
  title: '${projectName}',
  description: 'Local Firebase development with Pyric and Next.js',
};

interface LayoutProps {
  children: React.ReactNode;
}

export default function RootLayout({ children }: LayoutProps): React.JSX.Element {
  const containerStyle: React.CSSProperties = {
    font: '16px/1.5 system-ui, sans-serif',
    maxWidth: '640px',
    margin: '3rem auto',
    padding: '0 1rem',
  };

  return (
    <html lang="en">
      <body style={containerStyle}>
        {children}
      </body>
    </html>
  );
}
`;
}

function buildStatusApiRoute(): string {
  return `import { NextResponse } from 'next/server';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const DEFAULT_PROJECT_ID = 'demo-nextjs-app';

function getAdminApp() {
  const activeApps = getApps();
  if (activeApps.length > 0) {
    return activeApps[0];
  }
  return initializeApp({ projectId: DEFAULT_PROJECT_ID });
}

function resolveRuntimeEnvironment(): string {
  if (process.env.PYRIC_SANDBOX !== undefined) {
    return 'pyric-sandbox';
  }
  return 'production';
}

export async function GET(): Promise<NextResponse> {
  const app = getAdminApp();
  const db = getFirestore(app);
  
  try {
    const postsSnapshot = await db.collection('posts').get();
    const documentCount = postsSnapshot.size;
    const runtimeTarget = resolveRuntimeEnvironment();

    return NextResponse.json({
      status: 'ok',
      environment: runtimeTarget,
      count: documentCount,
    });
  } catch (error) {
    const errCode = (error as { code?: string }).code;
    const errMessage = errCode !== undefined ? errCode : String(error);
    return NextResponse.json(
      { status: 'error', details: errMessage },
      { status: 500 },
    );
  }
}
`;
}

function buildHomePage(projectName: string): string {
  return `'use client';

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
    return \`Signed in as \${currentUser.displayName}\`;
  }
  if (currentUser.email !== null && currentUser.email !== '') {
    return \`Signed in as \${currentUser.email}\`;
  }
  return \`Signed in as \${currentUser.uid}\`;
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
    });

    fetch('/api/status')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(\`Server returned HTTP \${response.status}\`);
        }
        const payload = (await response.json()) as ServerStatusResponse;
        return payload;
      })
      .then((payload) => {
        if (payload.status === 'ok' && payload.environment !== undefined && payload.count !== undefined) {
          setBackendApiStatusText(\`Server-Side Admin API Runtime: \${payload.environment} (\${payload.count} database records)\`);
        } else {
          const failureDetail = payload.details !== undefined ? payload.details : 'Unknown error';
          setBackendApiStatusText(\`Server-Side Admin API reported an error: \${failureDetail}\`);
        }
      })
      .catch((err: unknown) => {
        const failureDetail = err instanceof Error ? err.message : String(err);
        setBackendApiStatusText(\`Server-Side Admin API unavailable (\${failureDetail})\`);
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
        setAuthStatusText(\`Write operation failed: \${displayMessage}\`);
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
      <h1>${projectName}</h1>
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
`;
}

function buildReadme(projectName: string): string {
  return `# ${projectName}

A Firebase web application built with Next.js and wrapped with \`@pyric/cli/next\` (\`withPyric\`).
In development, the application runs entirely on Pyric's local sandbox—requiring
zero Firebase projects, service account keys, or cloud emulators.

- **Develop:** \`npm run dev\` or \`bun run dev\` — executes \`pyric dev -- next dev\`. The \`withPyric\` wrapper substitutes client SDK imports with local sandbox mirrors via Webpack and Turbopack aliases, intercepts server-side API requests via \`@pyric/cli/register\`, and proxies WebSocket bridge connection traffic automatically.
- **Build for production:** \`npm run build\` or \`bun run build\` — executing \`next build\` in production mode activates identity passthrough in \`withPyric\`, compiling standard Firebase and Firebase Admin SDKs untouched with zero runtime overhead.
- **Start:** \`npm start\` or \`bun run start\` — serves your built Next.js production server.
- **Deploy:** \`npx firebase-tools deploy\` (via Firebase Web Frameworks) after production build, or deploy standard built artifacts directly to Vercel and cloud compute platforms.
`;
}

export const NEXTJS_TEMPLATE: ScaffoldTemplate = {
  scripts: {
    dev: 'pyric dev -- next dev',
    'dev:direct': 'next dev',
    build: 'next build',
    start: 'next start',
  },
  dependencies: {
    firebase: '^12.12.0',
    'firebase-admin': '^13.0.0',
    next: '^15.0.0',
    react: '^19.0.0',
    'react-dom': '^19.0.0',
  },
  devDependencies: {
    '@pyric/cli': '*',
    '@types/node': '^22.0.0',
    '@types/react': '^19.0.0',
    '@types/react-dom': '^19.0.0',
    typescript: '^5.7.0',
  },
  dirs: ['src', 'src/app', 'src/app/api', 'src/app/api/status'],
  files: (name: string) => [
    { name: 'next.config.mjs', content: NEXTJS_CONFIG_MJS },
    { name: 'tsconfig.json', content: NEXTJS_TSCONFIG_JSON },
    { name: '.env.example', content: NEXTJS_ENV_EXAMPLE },
    { name: '.gitignore', content: NEXTJS_GITIGNORE },
    { name: 'firebase.json', content: NEXTJS_FIREBASE_JSON },
    { name: 'firestore.indexes.json', content: NEXTJS_FIRESTORE_INDEXES },
    { name: 'firestore.rules', content: NEXTJS_FIRESTORE_RULES },
    { name: 'README.md', content: buildReadme(name) },
    { name: 'src/app/layout.tsx', content: buildRootLayout(name) },
    { name: 'src/app/page.tsx', content: buildHomePage(name) },
    { name: 'src/app/api/status/route.ts', content: buildStatusApiRoute() },
  ],
  nextSteps: [
    'npm install    # or: bun install',
    'npm run dev    # Next.js dev server on the Pyric sandbox',
    'npm run build  # production build against real Firebase',
  ],
};
