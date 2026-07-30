---
name: pyric-inpage-sandbox
description: >-
  Embed Pyric's in-page Firestore, Storage, and Auth sandbox directly into standalone HTML pages, browser widgets, or UI artifacts without a CLI, backend, or Vite dev server. Use when building client-only prototypes, standalone HTML artifacts, or browser demos that require a functioning local Firestore and Storage database with real-time listeners, security rules, and document seeding. Don't use when developing a standard Vite or Node application (use pyric-start instead) or when auditing an existing Firebase app (use improve-firebase).
---

# Embed Pyric In-Page Sandbox (No CLI or Dev Server)

Run a fully functional, in-memory Firestore, Storage, and Auth sandbox directly inside a browser page or standalone HTML artifact. This pattern requires zero backend services, zero CLI background processes, and zero Vite development servers.

## Core API & Package Imports

In-page browser scripts interact with four primary Pyric modules:

| Subpath | Key Exports | Role |
| :--- | :--- | :--- |
| `pyric/sandbox` | `initializeSandbox`, `SandboxContext` | Root sandbox lifecycle and identity handles |
| `pyric/firestore` | `getFirestore`, `collection`, `doc`, `addDoc`, `updateDoc`, `deleteDoc`, `onSnapshot`, `query`, `orderBy`, `where` | Modular Web-SDK Firestore mirrors (routes to local sandbox) |
| `pyric/sandbox/firestore` | `setRules`, `seedDocuments`, `inspect`, `snapshotDocuments` | Service-specific sandbox controls for Firestore |
| `pyric/storage` | `getStorageSandbox`, `getStorage`, `ref`, `uploadBytes`, `getDownloadURL`, `deleteObject`, `uploadString`, `getMetadata`, `updateMetadata` | Modular Web-SDK Storage mirror & local IDB storage engine |
| `pyric/auth` | `getAuth`, `signInAnonymously`, `signOut`, `onAuthStateChanged`, `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, `updateProfile`, `signInWithPopup`, `GoogleAuthProvider`, `sandbox as authSandbox` | Modular Web-SDK Auth mirror & sandbox driver for Auth |
| `pyric/messaging` | `getMessaging`, `getToken`, `deleteToken`, `onMessage`, `isSupported`, `sandbox as messagingSandbox` | Modular Web-SDK Cloud Messaging (FCM) client mirror & test delivery driver |
| `pyric/ai` | `getAI`, `getGenerativeModel`, `Schema`, `ObjectSchema`, `StringSchema`, `ArraySchema` | Modular Web-SDK Firebase AI Logic mirror over local answer engine |
| `pyric/ai/scripting` | `script` | Sandbox-only deterministic response scripting for local prototypes & tests |
| `pyric/database` | `getDatabase`, `ref`, `child`, `get`, `set`, `update`, `remove`, `push`, `onValue`, `serverTimestamp` | Modular Web-SDK Realtime Database mirror (routes to local RtdbBackend tree) |
| `pyric/sandbox/database` | `setRules`, `setData`, `getActiveRules`, `snapshotState` | Service-specific rules and fixture controls for Realtime Database |

> [!IMPORTANT]
> Always import from public modular paths (`pyric/sandbox`, `pyric/firestore`, `pyric/sandbox/firestore`, `pyric/storage`, `pyric/auth`, `pyric/messaging`, `pyric/ai`, `pyric/ai/scripting`, `pyric/database`, and `pyric/sandbox/database`). Do not import from internal paths in application code. Note that both `pyric/storage` and `pyric/database` export `ref`, so alias your imports (`import { ref as rtdbRef } from 'pyric/database'`) to prevent symbol collisions.
> **Note on Service Handles:** You can pass a bare `Sandbox` handle directly to `getFirestore(sandbox)`, `getDatabase(sandbox)`, `getAuth(sandbox)`, `getMessaging(sandbox)`, `getAI(sandbox)`, and `getStorageSandbox(sandbox, { rules })`. Use `getStorage(app)` or `getMessaging(app)` when working with a standard `FirebaseApp` handle.

---

## 1. Synchronous Initialization & Rules Configuration

Unlike remote emulators, `initializeSandbox()`, `getFirestore(sandbox)`, `getStorageSandbox(sandbox, { rules })`, and `getAuth(sandbox)` execute synchronously in browser memory.

```javascript
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot } from 'pyric/firestore';
import { setRules, seedDocuments, inspect } from 'pyric/sandbox/firestore';
import { getStorageSandbox, ref, uploadBytes, getDownloadURL, deleteObject } from 'pyric/storage';
import { getAuth, signInAnonymously, signOut, onAuthStateChanged, sandbox as authSandbox } from 'pyric/auth';

// 1. Initialize root sandbox, Firestore, and Auth services
const sandbox = initializeSandbox();
const db = getFirestore(sandbox);
const auth = getAuth(sandbox);

// 2. Evaluate Firestore Security Rules with Authentication enforcement
const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /todos/{todo} {
      allow read: if true;
      allow create: if request.auth != null && request.resource.data.ownerId == request.auth.uid;
      allow update, delete: if request.auth != null && resource.data.ownerId == request.auth.uid;
    }
  }
}`;
setRules(sandbox, FIRESTORE_RULES);

// 3. Initialize Firebase Storage with Security Rules (enforcing Auth, Size limits, and MIME types)
const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /task_attachments/{taskId}/{fileName} {
      allow read: if true;
      allow create: if request.auth != null
                   && request.resource.size < 5 * 1024 * 1024
                   && request.resource.contentType.matches('image/.*');
      allow update, delete: if request.auth != null;
    }
  }
}`;
const storage = getStorageSandbox(sandbox, { rules: STORAGE_RULES });
```

---

## 2. In-Page Firebase Storage (`pyric/storage`) & Attachment Uploads

Pyric's `pyric/storage` module mirrors standard Firebase Web SDK upload/download signatures (`ref`, `uploadBytes`, `getDownloadURL`, `deleteObject`) and executes against an in-memory IndexedDB backend with live security rules evaluation.

### Example: Uploading & Removing a Task Image Attachment

```javascript
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'pyric/storage';

async function attachFileToTask(taskId, file) {
  const storageRef = ref(storage, `task_attachments/${taskId}/${file.name}`);
  try {
    // Upload bytes with contentType metadata — Storage rules enforce size < 5MB and image/* MIME
    await uploadBytes(storageRef, file, { contentType: file.type || 'image/png' });
    const downloadUrl = await getDownloadURL(storageRef);

    // Save download URL on the corresponding Firestore document
    await updateDoc(doc(db, 'todos', taskId), {
      attachmentUrl: downloadUrl,
      attachmentName: file.name
    });
  } catch (err) {
    console.error('Storage upload denied by Security Rules:', err.message);
  }
}

async function removeAttachment(taskId, fileName) {
  try {
    await deleteObject(ref(storage, `task_attachments/${taskId}/${fileName}`));
    await updateDoc(doc(db, 'todos', taskId), {
      attachmentUrl: null,
      attachmentName: null
    });
  } catch (err) {
    console.error('Storage deletion denied by Security Rules:', err.message);
  }
}
```

---

## 3. In-Page Cloud Messaging (`pyric/messaging`) & Simulated Push Delivery

Pyric mirrors Firebase Cloud Messaging (`firebase/messaging`) over an in-memory delivery broker (`MessagingBroker`) that routes push messages locally without browser permission dialogs, external Service Workers, or network calls to FCM.

### Best Practice: Gesture-Driven Token Requests & Revocation

Following `/improve-firebase` architectural discipline:
1. **Never call `getToken` immediately on load**: In production builds, calling `getToken` immediately triggers an intrusive browser permission dialog ("This site wants to show notifications"). Always bind `getToken` to a direct user gesture (such as clicking an "Enable Push Notifications" button).
2. **Revoke on Sign-Out**: When a user logs out in `onAuthStateChanged`, call `deleteToken(messaging)` so unauthenticated client identities do not retain active push targets.
3. **Gate Listeners & Deliveries on Token State**: Because Pyric's test driver (`messagingSandbox.deliver`) is designed to inject messages into client handles regardless of registration state, always verify that push notifications are enabled (`if (!activeToken) return`) before delivering application events or rendering toast dialogs in `onMessage`. Never invoke visual toast renderers directly from application feature logic without checking token state.

### Simulating Push Deliveries with `messagingSandbox.deliver`

Because standalone HTML prototypes and preview iframes (`about:srcdoc`) cannot register external Service Worker files, you can simulate realistic incoming push alerts and silent data syncs using Pyric's sandbox driver (`messagingSandbox.deliver`):

```javascript
import { getMessaging, getToken, deleteToken, onMessage, sandbox as messagingSandbox } from 'pyric/messaging';

// Initialize Cloud Messaging mirror directly from the root sandbox
const messaging = getMessaging(sandbox);
let activeToken = null;

// 1. Subscribe to foreground deliveries (gate on activeToken so revoked targets ignore messages!)
onMessage(messaging, (payload) => {
  if (!activeToken) return;
  console.log('📬 Received FCM delivery:', payload);
  renderToast(payload.notification?.title, payload.notification?.body, payload.data);
});

// 2. Obtain token on explicit user gesture
async function enableNotifications() {
  const token = await getToken(messaging); // Mints a stable, production-shaped APA91b... token
  console.log('FCM Token:', token);
}

// 3. Inject simulated deliveries via Pyric broker during local demos
async function simulateOverdueAlert() {
  await messagingSandbox.deliver(messaging, {
    visibilityState: 'visible',
    notification: {
      title: '⏰ Task Overdue',
      body: 'Your high priority task requires immediate attention.'
    },
    data: { action: 'open_todo', taskId: '123' }
  });
}
```

---

## 4. In-Page Firebase AI Logic (`pyric/ai`) & Deterministic Scripting

Pyric mirrors Firebase AI Logic (`getAI`, `getGenerativeModel`, `generateContent`) over an in-process answer engine. By default (`engine: { kind: 'scripted' }`), it operates with zero network configuration, allowing you to script deterministic model replies using `script(ai, entries)` from `pyric/ai/scripting`.

### Best Practices from `/improve-firebase` (AI Logic Audit)

When auditing or prototyping Firebase AI features in-page, apply these rules:
1. **Validate Before Database Writes**: Never blindly dump LLM text into Firestore. Always parse and schema-validate model output in client memory before performing mutations (e.g. `addDoc`). Reject malformed responses safely without database contamination.
2. **Cover Normal & Failure Paths with `script()`**: Don't just test sunny-day structured JSON. Use `script(ai, [...])` to verify application fallback handling for malformed text output and simulated service errors (`HTTP 429 RESOURCE_EXHAUSTED`).
3. **Isolate Scripting from Production API Call Sites**: Application functions should call standard `getGenerativeModel` and `model.generateContent(prompt)`. Keep `script(ai, [...])` inside test fixture selectors or harness code so production builds work cleanly against live Firebase AI endpoints.

```javascript
import { getAI, getGenerativeModel } from 'pyric/ai';
import { script } from 'pyric/ai/scripting';

const ai = getAI(sandbox);
const model = getGenerativeModel(ai, { model: 'gemini-2.5-pro', generationConfig: { responseMimeType: 'application/json' } });

// 1. Scripting a deterministic structured JSON fixture
script(ai, [{
  respond: {
    text: JSON.stringify([{ title: "Implement passkey auth", priority: "High" }])
  }
}]);

// 2. Scripting a simulated 429 Quota Exceeded failure to test application recovery
script(ai, [{
  respond: {
    error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for gemini-2.5-pro.' }
  }
}]);
```

---

## 5. In-Page Realtime Database (`pyric/database`): Flat Schemas & Atomic Fan-Out

Pyric mirrors Firebase Realtime Database over a local `RtdbBackend` JSON tree, allowing synchronous offline execution of `onValue` listeners, queries, transactions, and declarative rules.

### Best Practices from `/improve-firebase` (RTDB Rules & Data Model)

1. **Flat Entity Trees**: Never nest entity types inside one another. Design top-level collections around read access patterns (`/presence`, `/activity_stream`). Use push IDs (`push()`) for append-only chronological logs.
2. **Atomic Multi-Path Fan-Out Writes**: When duplicating denormalized summary data, update all copies atomically via a single multi-path fan-out write (`update(ref(rtdb), { ['pathA']: data, ['pathB']: data })`).
3. **Cascading Access vs `.validate` Shapes**: In RTDB, `.read` / `.write` access cascades downward (a permissive parent grants all descendants!). Lock the root (`".read": false, ".write": false`), open specific child paths, and add `.validate` rules to verify structure, types (`isString()`, `isBoolean()`), and mandatory children (`hasChildren([...])`).

### The Locked RTDB Error Contract (Plain Error vs FirebaseError)

Unlike Firestore—which throws an error with `.code === 'permission-denied'` and attaches a rich `denialContext`—Pyric RTDB strictly mirrors canonical `firebase/database` rule rejection behavior:
- Throws a **plain `Error`** (NOT a `FirebaseError`).
- `.code === 'PERMISSION_DENIED'` (uppercase snake-case, distinct from Firestore's `'permission-denied'`).
- `.message === 'PERMISSION_DENIED: Permission denied'`.

When building universal denial banners, always inspect plain errors for `.code === 'PERMISSION_DENIED'`.

```javascript
import { getDatabase, ref as rtdbRef, onValue, set, update } from 'pyric/database';
import { setRules as setRtdbRules, setData as setRtdbData } from 'pyric/sandbox/database';

const rtdb = getDatabase(sandbox);

// 1. Lock root and enforce strict .validate schema expressions
setRtdbRules(sandbox, {
  rules: {
    ".read": false,
    ".write": false,
    presence: {
      ".read": true,
      "$uid": {
        ".write": "auth !== null && auth.uid === $uid",
        ".validate": "newData.hasChildren(['online', 'user']) && newData.child('online').isBoolean()"
      }
    }
  }
});

// 2. Seed initial JSON tree state BEFORE registering real-time listeners
setRtdbData(sandbox, {
  presence: { 'alice': { online: true, user: 'Alice' } }
});

// 3. Subscribe to real-time value changes
onValue(rtdbRef(rtdb, 'presence'), (snapshot) => {
  console.log('📡 RTDB Presence state:', snapshot.val());
});
```

---

## 6. Swappable Traditional Sign-In & Sign-Up Flows (No Hacked Demos!)

Because `pyric/auth` is a 1:1 mirror of the standard Firebase Web SDK (`firebase/auth`), **always build traditional Sign-In and Create Account (Registration) UIs** rather than hacked demo buttons. The exact same registration and authentication form code runs unmodified against both in-page `pyric/auth` and production Firebase.

### Traditional Create Account Flow (`createUserWithEmailAndPassword` + `updateProfile`)

When a user submits a registration form, Pyric validates email format and password strength (>=6 chars), creates the account, and signs the user in:

```javascript
import { createUserWithEmailAndPassword, updateProfile } from 'pyric/auth';

async function handleEmailSignUp(name, email, password) {
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    if (name && cred.user) {
      await updateProfile(cred.user, { displayName: name });
    }
    console.log('Account created successfully:', cred.user.uid, cred.user.displayName);
  } catch (err) {
    console.error('Registration error:', err.code, err.message);
  }
}
```

### Traditional Email/Password Sign-In Flow (`signInWithEmailAndPassword`)

```javascript
import { signInWithEmailAndPassword } from 'pyric/auth';

async function handleEmailSignIn(email, password) {
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    console.log('Signed in as:', cred.user.displayName || cred.user.email);
  } catch (err) {
    console.error('Sign-in error:', err.code, err.message);
  }
}
```

### Pluggable OAuth Provider Console (`AuthFlowResolver` + `listUsers`, `deleteUser`, `createUser`)

For federated sign-in (`signInWithPopup(auth, new GoogleAuthProvider())`), Pyric provides a pluggable seam called `AuthFlowResolver` (`authSandbox.setAuthFlowResolver`). Inside `openPopup`, you can render an interactive **OAuth Account Picker & User Management Console** backed by Pyric's sandbox user admin methods (`listUsers`, `deleteUser`, and `createUser`):

```javascript
import { signInWithPopup, GoogleAuthProvider, sandbox as authSandbox } from 'pyric/auth';

// 1. Enable the provider in the sandbox
authSandbox.setAuthProviderConfig(auth, 'google.com', true);

// 2. Register an AuthFlowResolver that renders an existing account selector and account creation form
authSandbox.setAuthFlowResolver(auth, {
  openPopup: (authInstance, provider) => {
    return new Promise((resolve, reject) => {
      // 1. Query all existing test accounts in the sandbox
      const existingUsers = authSandbox.listUsers(authInstance);

      // 2. Render an interactive modal allowing the user to:
      // - Select an existing account:
      //     resolve({ user: u, providerId: provider.providerId, operationType: 'signIn' })
      // - Delete an existing account:
      //     authSandbox.deleteUser(authInstance, u.uid);
      // - Create a new test user on the fly:
      //     const record = authSandbox.createUser(authInstance, { uid, email, displayName });
      //     resolve({ user: record, providerId: provider.providerId, operationType: 'signIn' });
      // - Cancel the flow:
      //     reject(Object.assign(new Error('Popup closed by user'), { code: 'auth/popup-closed-by-user' }));
    });
  },
  openRedirect: async () => { throw new Error('Redirect not simulated'); }
});
```

### Listening to Auth State & Clearing Stale UI on Sign Out

```javascript
// Keep reference to latest Firestore snapshot so logging in/out immediately updates UI
let latestSnapshot = null;

function updateUIFromSnapshot(snapshot) {
  if (!snapshot) return;
  if (auth.currentUser) {
    todos = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  } else {
    // IMPORTANT: Clear cached collection data so unauthenticated users cannot interact with stale items
    todos = [];
  }
  renderUI();
}

onSnapshot(collection(db, 'todos'), (snapshot) => {
  latestSnapshot = snapshot;
  updateUIFromSnapshot(snapshot);
});

onAuthStateChanged(auth, (user) => {
  if (user) {
    const label = user.displayName || user.email || 'Anonymous';
    console.log(`Signed in as ${label} (${user.uid})`);
  }
  // IMPORTANT: Re-evaluate collection views against the latest snapshot whenever Auth state changes!
  // onSnapshot only fires on document mutations; it will not automatically re-emit when auth changes.
  updateUIFromSnapshot(latestSnapshot);
});
```

---

## 7. Document Seeding & Realtime Listeners (Call `seedDocuments` BEFORE `onSnapshot`!)

`seedDocuments(sandbox, records)` is a bulk fixture utility that replaces the initial sandbox state **without synthesizing events or triggering listener callbacks**.

> [!WARNING]
> **Always call `seedDocuments` BEFORE subscribing to `onSnapshot`.** If you call `seedDocuments` inside an `onSnapshot` callback after checking `snapshot.empty`, the listener will not fire a second time for the seeded documents, causing your UI to appear empty until a subsequent manual write occurs.

```javascript
const todosRef = collection(db, 'todos');

// 1. Seed initial documents FIRST before subscribing to onSnapshot
seedDocuments(sandbox, {
  'todos/1': { title: 'Implement passkey auth', completed: false, priority: 'High', ownerId: 'alice', createdAt: Date.now() - 3600000 },
  'todos/2': { title: 'Review WCAG contrast', completed: true, priority: 'High', ownerId: 'alice', createdAt: Date.now() - 7200000 }
});

// 2. Subscribe to onSnapshot — initial emission will immediately deliver the seeded documents
onSnapshot(todosRef, (snapshot) => {
  const items = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  renderUI(items);
});
```

---

## 8. Exposing Rich Security Rule Debug Errors (`denialContext`)

Pyric's signature feature is that a `permission-denied` error is **never an opaque black box**. When a Firestore mutation is denied by security rules, Pyric attaches a rich `denialContext` object to the `SandboxError`.

> [!CAUTION]
> **Do not check only `denial.rule`!** In Pyric's current AST evaluator, `denial.rule` (`line` + `expression`) may be absent until source-position tracking lands. However, `denial.reasons`, `denial.request`, `denial.resource`, and `denial.auth` are **always populated** when `permission-denied` is raised. Never fall back to a generic message if `denial.rule` is undefined.

### Inspecting All Available Fields on `err.denialContext`

When an operation fails, extract the complete debug context so AI agents and developers can diagnose why the rule failed:

```javascript
try {
  await updateDoc(doc(db, 'todos/1'), { completed: true });
} catch (err) {
  const denial = err.denialContext;
  if (err.code === 'permission-denied' && denial) {
    // 1. Simulator reasoning lines (the underlying engine's debugMessages)
    const reasons = (denial.reasons && denial.reasons.length > 0)
      ? denial.reasons.join('\n')
      : err.message;

    // 2. Evaluated Auth identity (null if signed out)
    const authUid = denial.auth ? denial.auth.uid : 'Signed out (null)';

    // 3. Proposed write (request.resource.data) and existing document (resource.data)
    const proposedData = denial.request ? denial.request.resourceData : null;
    const existingData = denial.resource ? denial.resource.data : null;

    // 4. Rule expression and line number (if present in AST)
    const ruleLine = denial.rule ? denial.rule.line : 'N/A';
    const ruleExpr = denial.rule ? denial.rule.expression : '';

    console.group('🔒 Security Rule Denial Details');
    console.log('Rule Line:', ruleLine, 'Expression:', ruleExpr);
    console.log('Simulator Reasoning:', reasons);
    console.log('Evaluated Auth:', authUid);
    console.log('Proposed Write:', proposedData);
    console.log('Existing Document:', existingData);
    console.groupEnd();

    // Display all of the above in your UI so agents and developers can fix the rules
    showRichDenialModal({
      reasons,
      authUid,
      proposedData,
      existingData,
      ruleLine,
      ruleExpr
    });
  } else {
    console.error('Operation failed:', err);
  }
}
```

---

## 9. The Developer Console Pattern: Isolating Sandbox Drivers from Application UI

To ensure your frontend prototype accurately mimics a production application and remains zero-diff swappable with canonical `firebase/*` packages, **never clutter your primary application UI with test fixtures, simulation buttons, or engine mode switchers**.

### Approved Main Page Exceptions
1. **Universal Error / Rule Denial Banners**: Retain a top-level error boundary to surface rich `permission-denied` (Firestore/Storage) or plain `PERMISSION_DENIED` (RTDB) context to developers and AI agents during live interaction.
2. **Pluggable Auth Helpers**: Test account switchers or mock OAuth pickers required to simulate identity transitions without browser popups.

### The Multi-Tabbed Developer Console Modal
Move all service-specific test drivers and mock controls into an expanded developer modal triggered by an **"Inspect Sandbox"** button:
- **Tab 1: Firestore & Storage**: Display active document counts, in-memory collection dumps (`inspect(sandbox)` / `snapshotDocuments()`), and active security rule text.
- **Tab 2: Realtime Database (RTDB)**: House real-time monitors for `/presence` and `/activity_stream`, along with interactive verification buttons (e.g. toggling presence, triggering atomic multi-path fan-out writes, or asserting `.validate` rule failures).
- **Tab 3: AI Logic Scripting & Task Assistant**: Relocate both the interactive AI task generator widget and the `script(ai, [...])` fixture selector into this console tab, allowing developers to test structured JSON generation, malformed schema rejection, and simulated `HTTP 429` quota fallback states without occupying the primary application UI.
- **Tab 4: Cloud Messaging Simulator**: Relocate `messagingSandbox.deliver(...)` push triggers here (overdue alerts, collaborator edits, silent data syncs), displaying active token state while preserving a clean application notification toggle.

---

## 10. CSP & Standalone Artifacts: The Inline Bundle Pattern

When embedding an HTML artifact into sandboxed preview iframes (e.g., `about:srcdoc` in chat UI), **external CDNs and import maps (`https://esm.sh`) are blocked by Content Security Policy (CSP)**.

If `<script type="importmap">` points to external URLs, module script evaluation fails silently, causing DOM event handlers to throw `ReferenceError: <fn> is not defined`.

### How to Build a Self-Contained Inline Bundle with Bun

To embed Pyric into a standalone artifact without CSP restrictions:

1. **Build `dist/` in the Pyric repository** (if working from source):
   ```bash
   bun run --cwd packages/pyric build
   ```

2. **Create a temporary entrypoint (`pyric-entry.ts`)** exporting required symbols to `window`:
   ```typescript
   import { initializeSandbox } from 'pyric/sandbox';
   import { getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot } from 'pyric/firestore';
   import { setRules, seedDocuments, inspect } from 'pyric/sandbox/firestore';
   import {
     getAuth,
     signInAnonymously,
     signOut,
     onAuthStateChanged,
     signInWithEmailAndPassword,
     createUserWithEmailAndPassword,
     updateProfile,
     signInWithPopup,
     GoogleAuthProvider,
     sandbox as authSandbox
   } from 'pyric/auth';
   import {
     getStorage,
     ref,
     uploadBytes,
     getDownloadURL,
     deleteObject
   } from 'pyric/storage';

   (window as any).Pyric = {
     initializeSandbox,
     getFirestore,
     collection,
     doc,
     addDoc,
     updateDoc,
     deleteDoc,
     onSnapshot,
     setRules,
     seedDocuments,
     inspect,
     getAuth,
     signInAnonymously,
     signOut,
     onAuthStateChanged,
     signInWithEmailAndPassword,
     createUserWithEmailAndPassword,
     updateProfile,
     signInWithPopup,
     GoogleAuthProvider,
     authSandbox,
     getStorage,
     ref,
     uploadBytes,
     getDownloadURL,
     deleteObject
   };
   ```

3. **Bundle for browser execution** from the workspace root (where `pyric` is a workspace package):
   ```bash
   bun build pyric-entry.ts --target=browser --minify --outfile=pyric-bundle.min.js
   ```

4. **Inline the minified bundle directly into `<script>` tags** inside your HTML file.

---

## 11. Critical Gotchas & Checklist

- [ ] **Isolate Sandbox Drivers from Application UI**: Keep your main frontend prototype clean and production-swappable by placing simulated push controllers, AI fixture dropdowns, and RTDB atomic test buttons inside an expanded developer console modal triggered by an "Inspect Sandbox" button.
- [ ] **Full-Screen Developer Console & Flex Heights**: Design your Developer Console modal as full screen (`max-w-[1500px] sm:max-h-[94vh] flex flex-col`) with every tab using identical full-height flex column layout (`flex-1 flex flex-col min-h-0`) so panels don't jump in height and scrollbars format gracefully.
- [ ] **Universal Clipboard Fallback in Sandboxed Iframes**: When running in `about:srcdoc` preview iframes, `navigator.clipboard.writeText(...)` throws a `NotAllowedError`. Always wrap copy buttons in a fallback helper that uses an invisible DOM `<textarea>` and `document.execCommand('copy')`.
- [ ] **Alias RTDB vs Storage `ref` Imports**: Both `pyric/storage` and `pyric/database` export a function named `ref`. Always alias your imports (`import { ref as rtdbRef } from 'pyric/database'`) to prevent module collisions.
- [ ] **Inspect Plain Errors for RTDB Rule Denials**: Unlike Firestore (`permission-denied` with `denialContext`), RTDB throws a plain `Error` with `.code === 'PERMISSION_DENIED'` (uppercase snake-case) and `.message === 'PERMISSION_DENIED: Permission denied'`. Always check plain error codes in universal denial banners.
- [ ] **Use Flat Entity Collections in RTDB**: Never nest entity schemas inside one another; design top-level trees around screen read sizes (`/presence`, `/activity_stream`) and update duplicate nodes atomically via multi-path fan-out writes (`update()`).
- [ ] **Validate AI Output Before Database Writes**: Never pass raw generative text directly into Firestore mutations (`addDoc`). Always parse and schema-validate responses in memory, presenting a user-visible fallback if the LLM returns unstructured or malformed text.
- [ ] **Test AI Failure Paths with `script()`**: Don't limit AI prototypes to successful structured JSON. Use `script(ai, [...])` from `pyric/ai/scripting` to simulate quota exhaustion (`HTTP 429 RESOURCE_EXHAUSTED`) and invalid schema returns to prove UI resilience.
- [ ] **Gesture-Driven FCM Registration**: Never call `getToken(messaging)` immediately on page load. Always require an explicit user action ("Enable Push Notifications") to avoid production browser permission denials.
- [ ] **Revoke Push Tokens on Sign Out**: Call `deleteToken(messaging)` inside `onAuthStateChanged` when the user signs out so inactive sessions cease receiving simulated or production push deliveries.
- [ ] **Gate FCM Deliveries on Active Tokens**: Never display push notification toasts or process `onMessage` events if the user has not enabled push notifications or has revoked their token via `deleteToken`. Always check token registration state (`if (!activeToken) return`) before executing deliveries.
- [ ] **Enforce Firebase Storage Rules (`pyric/storage`)**: Always initialize Storage with rules (`getStorageSandbox(sandbox, { rules })`) checking authentication, MIME content types (`request.resource.contentType.matches('image/.*')`), and size boundaries (`request.resource.size < N`).
- [ ] **Dynamic Auth Resolution for Bare Sandbox Storage**: When initializing Storage with a bare sandbox (`getStorageSandbox(sandbox, { rules })`), Pyric resolves `request.auth` dynamically per-call (`() => sandbox.currentUser`) so signed-in identities are correctly evaluated by storage rules.
- [ ] **IndexedDB Sandbox Fallback**: When running in `about:srcdoc` or sandboxed preview iframes where `indexedDB.open()` is denied (`IDBFactory` SecurityError), Pyric's storage persistence layer automatically falls back to an in-memory backend (`InMemoryStorageBackend`), ensuring uploads and reads succeed without browser storage errors.
- [ ] **Selectable & Copyable Error Banners**: Ensure error banners and code blocks use `select-text cursor-text` and include a **Copy Error** button so developers and AI agents can select and copy full denial context traces.
- [ ] **Use Traditional Sign-Up & Sign-In Forms**: Always build standard registration and login UIs using `createUserWithEmailAndPassword`, `updateProfile`, and `signInWithEmailAndPassword` so your code is 100% swappable with production `firebase/auth`.
- [ ] **Use Pluggable `AuthFlowResolver` for OAuth**: For Google OAuth or other providers, use `authSandbox.setAuthFlowResolver(auth, { openPopup: ... })` to render custom in-page account picker views without external popups.
- [ ] **Leverage `authSandbox` Admin Methods in OAuth Views**: Use `authSandbox.listUsers(auth)`, `authSandbox.deleteUser(auth, uid)`, and `authSandbox.createUser(auth, {...})` to build interactive account pickers and test-identity management tools in your OAuth popup view.
- [ ] **Expose All `denialContext` Fields**: Do not rely solely on `denial.rule`; always extract and render `denial.reasons`, `denial.request.resourceData`, `denial.resource.data`, and `denial.auth` when `permission-denied` occurs.
- [ ] **Clear UI State on Sign Out & Refresh on Sign In**: When `onAuthStateChanged` fires (signing out, switching accounts, or signing in), clear local collections when unauthenticated (`todos = []`) and always re-evaluate against your cached Firestore snapshot (`updateUIFromSnapshot(latestSnapshot)`). `onSnapshot` only emits on document mutations and will not automatically fire when only `auth.currentUser` changes.
- [ ] **Seed BEFORE `onSnapshot`**: Always call `seedDocuments` before subscribing to `onSnapshot` because `seedDocuments` does not trigger listener callbacks.
- [ ] **Expose Event Handlers to `window`**: Functions defined in `<script type="module">` or IIFEs are module-scoped. To use them in HTML attributes (`onsubmit="handleAddTask(event)"`), assign them to `window` (`window.handleAddTask = handleAddTask`).
- [ ] **Do Not Use `localStorage` Fallbacks**: Pyric's in-page sandbox manages its own memory and IndexedDB state; do not mix manual `localStorage` serialization with `pyric/firestore` or `pyric/storage`.
- [ ] **Always Provide Security Rules**: Call `setRules(sandbox, RULES)` after `initializeSandbox()`, otherwise requests may fail depending on default deny policies.
