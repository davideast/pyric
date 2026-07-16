---
title: "Run canonical imports against Firebase"
navLabel: "Swap to prod backend"
group: "pyric / firestore"
section: "Tutorials"
order: 11003
---
# Run canonical imports against Firebase

In this lesson you will take the canonical-import demo from the previous
tutorial, remove sandbox activation, and observe Firebase becoming the backend
without changing the Firestore calls.

You need a Firebase project with Firestore enabled and a Web app configuration.

## 1. Confirm the application uses canonical imports

Your application module should import Firebase, not Pyric:

```ts
import { initializeApp } from 'firebase/app';
import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';

const app = initializeApp({
  apiKey: 'your-api-key',
  appId: 'your-app-id',
  projectId: 'your-project-id',
});

const db = getFirestore(app);
const ref = doc(db, 'notes/n1');
await setDoc(ref, { title: 'hello from production' });
console.log((await getDoc(ref)).data());
```

## 2. Deploy rules that permit the exercise

Create `firestore.rules`:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} {
      allow read, write: if request.auth != null;
    }
  }
}
```

Deploy the rules using your normal Firebase deployment workflow.

## 3. Sign in before the write

Add Firebase Auth to the application:

```ts
import { getAuth, signInAnonymously } from 'firebase/auth';

const auth = getAuth(app);
await signInAnonymously(auth);
```

Place these lines before `setDoc`. Enable anonymous authentication in the
Firebase console if the provider is not already enabled.

## 4. Run without Pyric activation

Do not set `PYRIC_SANDBOX`, preload `@pyric/cli/register`, or enable the Pyric
Vite plugin for this run:

```bash
node demo.mjs
```

You should see the document read back from the real Firebase project. Notice
that the application still imports `firebase/firestore`; only the environment
changed.

## 5. Compare with the sandbox run

Run the same file through the activated development seam while `pyric dev`
hosts the sandbox:

```bash
pyric dev -- node demo.mjs
```

This time package resolution selects the sandbox mirror. The Firebase
configuration is unused, the operation completes locally, and no production
request is made.

You have now run one source file through both sides of the package boundary.
There is no production dispatch inside `pyric/firestore`; the import resolver
selected the implementation before `getFirestore` executed.

Next, read
[Why package resolution owns backend selection](../pyric-firestore-explanation-two-backends-one-surface/)
for the architectural reasoning.
