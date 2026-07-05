/**
 * Dev-seed (Phase 0, F-SHELL): an in-page seeded sandbox so Studio renders for
 * review WITHOUT a live `pyric serve`.
 *
 * It builds one `Sandbox` via `initializeSandbox()` and populates it through the
 * modular SDKs exactly as a real app would:
 *   - Firestore: a `notes` collection (~12 docs, incl. nested map / array /
 *     geopoint / timestamp / reference fields), plus `users` and `posts`.
 *     Writes go through the ADMIN handle (`getAdminFirestore`) so the seed
 *     bypasses rules; it's a fixture, not an app action.
 *   - Auth: a handful of users incl. a Google-style verified user and an
 *     anonymous user, via the `sandbox.createUser` admin seam.
 *   - Storage: a couple of objects (an avatar PNG + a text note attachment).
 *
 * Everything here is import-gated behind `import.meta.env.DEV` at the call site
 * (`DevSeedProvider`) so it is tree-shaken out of production builds.
 */

import { initializeApp, type PyricApp } from 'pyric/app';
import {
  GeoPoint,
  Timestamp,
  doc,
  getAdminFirestore,
  getDoc,
  getFirestore,
  sandbox as firestoreOps,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore,
} from 'pyric/firestore';
import { getAuth, sandbox as authSandbox, type Auth } from 'pyric/auth';
import { getStorage, ref, uploadBytes, type FirebaseStorage } from 'pyric/storage';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';

/** The resolved handles a seeded Studio sandbox exposes to surfaces. */
export interface SeededHandles {
  sandbox: Sandbox;
  app: PyricApp;
  /** Rules-respecting handle (what the running app sees). */
  firestore: Firestore;
  /** Rules-bypass handle ("edit anything" / admin lens). */
  adminFirestore: Firestore;
  auth: Auth;
  storage: FirebaseStorage;
}

/** Three sandbox users: a Google-style verified user, a password user, and an
 *  anonymous one, created through the admin user seam. */
function seedAuth(auth: Auth): void {
  authSandbox.createUser(auth, {
    uid: 'alice',
    email: 'alice@gmail.com',
    displayName: 'Alice Nguyen',
    emailVerified: true,
    photoUrl: 'https://lh3.googleusercontent.com/a/alice',
    // Google-style sign-in is reflected by a verified Google email + photo.
    customClaims: { provider: 'google.com', plan: 'pro' },
  });
  authSandbox.createUser(auth, {
    uid: 'bob',
    email: 'bob@example.com',
    displayName: 'Bob Carter',
    emailVerified: true,
    customClaims: { role: 'editor' },
  });
  authSandbox.createUser(auth, {
    uid: 'carol',
    email: 'carol@example.com',
    displayName: 'Carol Diaz',
    emailVerified: false,
  });
  // An anonymous user: no email, no display name (Firebase's anon shape).
  authSandbox.createUser(auth, {
    uid: 'anon-7Hk2',
  });
}

/** A geopoint near SF, reused across the geo-tagged notes. */
const SF = new GeoPoint(37.7749, -122.4194);

/**
 * Build the dozen `notes`, three `users`, and two `posts`. Notes deliberately
 * exercise every "interesting" Firestore field type so the data surface has a
 * representative fixture: nested map, array, GeoPoint, Timestamp, and a
 * DocumentReference (to a user).
 */
async function seedFirestore(db: Firestore): Promise<void> {
  const now = Date.now();
  const minsAgo = (m: number) => Timestamp.fromMillis(now - m * 60_000);

  // ── users ──────────────────────────────────────────────────────────
  const users = [
    { id: 'alice', name: 'Alice Nguyen', email: 'alice@gmail.com', plan: 'pro' },
    { id: 'bob', name: 'Bob Carter', email: 'bob@example.com', plan: 'free' },
    { id: 'carol', name: 'Carol Diaz', email: 'carol@example.com', plan: 'free' },
  ];
  for (const u of users) {
    await setDoc(doc(db, 'users', u.id), {
      name: u.name,
      email: u.email,
      plan: u.plan,
      createdAt: serverTimestamp(),
    });
  }

  // ── notes (~12, varied field types) ────────────────────────────────
  const owners = ['alice', 'bob', 'carol'];
  const titles = [
    'Ship the redesign',
    'Reply to carol',
    'Buy milk',
    'Draft the launch post',
    'Review the rules',
    'Plan offsite',
    'Renew the domain',
    'Read the spec',
    'Fix the flaky test',
    'Call the bank',
    'Water the plants',
    'Book the flights',
  ];
  for (let i = 0; i < titles.length; i++) {
    const owner = owners[i % owners.length];
    await setDoc(doc(db, 'notes', `note-${String(i + 1).padStart(2, '0')}`), {
      title: titles[i],
      done: i % 3 === 0,
      pinned: i === 0,
      priority: (i % 3) + 1,
      ownerId: owner,
      // Reference field as a stored path (`users/alice`): the idiomatic,
      // walk-safe way to model a cross-reference here. (A live
      // `DocumentReference` value currently trips the sandbox's sentinel
      // walker (a pyric limitation outside Phase 0's scope) so the fixture
      // uses the path form, which the data surface still linkifies.)
      ownerRef: `users/${owner}`,
      // Array field.
      tags: i % 2 === 0 ? ['work', 'urgent'] : ['personal'],
      // Nested map field.
      meta: {
        source: i % 2 === 0 ? 'app' : 'import',
        revision: i + 1,
        flags: { starred: i % 4 === 0, archived: false },
      },
      // GeoPoint field (every third note is geo-tagged).
      location: i % 3 === 0 ? SF : null,
      // Timestamp fields.
      createdAt: minsAgo(120 - i * 7),
      updatedAt: serverTimestamp(),
    });
  }

  // ── posts ──────────────────────────────────────────────────────────
  await setDoc(doc(db, 'posts', 'post-hello'), {
    title: 'Hello world',
    body: 'First post from the seeded sandbox.',
    authorRef: 'users/alice',
    published: true,
    publishedAt: minsAgo(8),
  });
  await setDoc(doc(db, 'posts', 'post-draft'), {
    title: 'Draft: roadmap',
    body: 'Unpublished draft.',
    authorRef: 'users/bob',
    published: false,
  });
}

/** Put two small objects into Storage so the object browser has content. */
async function seedStorage(storage: FirebaseStorage): Promise<void> {
  const enc = new TextEncoder();
  // A tiny 1×1 transparent PNG so the avatar reads as a real image.
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const pngBytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));

  await uploadBytes(ref(storage, 'avatars/alice.png'), pngBytes, {
    contentType: 'image/png',
  });
  await uploadBytes(
    ref(storage, 'notes/note-01/attachment.txt'),
    enc.encode('Attachment for the redesign note.\n'),
    { contentType: 'text/plain' },
  );
}

/**
 * A representative ruleset, deployed so the app-session ops below are actually
 * evaluated (and some are denied). `notes`/`users` are owner-scoped; `posts` are
 * world-readable. This is what gives Traffic real allow/deny decisions and the
 * Session/Rules surfaces real denials to debug.
 */
const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == userId;
    }
    match /notes/{noteId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null && request.resource.data.ownerId == request.auth.uid;
      allow update, delete: if request.auth != null && resource.data.ownerId == request.auth.uid;
    }
    match /posts/{postId} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}
`;

/**
 * Drive a handful of RULES-RESPECTING ops as different identities so the unified
 * event stream carries real `request` events: allows AND denials. These are the
 * source the Traffic timeline buckets, the Session action items surface, and the
 * Rules surface debugs. Denied ops throw `permission-denied`; we swallow it (the
 * denial is the point, recorded on the event stream).
 */
async function seedTraffic(sandbox: Sandbox, adminDb: Firestore): Promise<void> {
  firestoreOps.setRules(adminDb, RULES);

  const asAlice = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  const asBob = getFirestore(sandbox.withAuth({ uid: 'bob' }));
  const asAnon = getFirestore(sandbox.withAuth(null));

  const swallow = async (op: Promise<unknown>) => {
    try {
      await op;
    } catch {
      // A denied op throws permission-denied (expected); the request event with
      // `result: 'deny'` is already on the stream, which is what we're seeding.
    }
  };

  // ── allowed (result: allow) ──────────────────────────────────────────
  await swallow(getDoc(doc(asAlice, 'notes', 'note-01'))); // alice reads (auth != null)
  await swallow(updateDoc(doc(asAlice, 'notes', 'note-01'), { pinned: true })); // owns it
  await swallow(getDoc(doc(asBob, 'notes', 'note-02'))); // bob reads his note
  await swallow(getDoc(doc(asAnon, 'posts', 'post-hello'))); // posts are public

  // ── denied (result: deny), the action items + rules-debug feed ──────
  await swallow(getDoc(doc(asAnon, 'notes', 'note-03'))); // anon read, auth == null
  await swallow(updateDoc(doc(asBob, 'notes', 'note-01'), { pinned: false })); // not bob's note
  await swallow(updateDoc(doc(asAnon, 'users', 'alice'), { plan: 'free' })); // anon write
}

/**
 * Build + seed a fresh sandbox and return the resolved handles. Idempotent per
 * call: each invocation creates its own sandbox, so callers should create one
 * and share it (see {@link DevSeedProvider}).
 */
/**
 * (Re)apply the fixture DATA (firestore + auth + storage) through the given
 * handles. Reused by {@link createSeededSandbox} on boot and by the Studio's
 * "Reset session" in dev-seed mode. Traffic is deliberately NOT replayed -
 * reset restores data, not the denial/activity log (replaying would double it).
 */
export async function applySeed(
  handles: Pick<SeededHandles, 'adminFirestore' | 'auth' | 'storage'>,
): Promise<void> {
  await seedFirestore(handles.adminFirestore);
  seedAuth(handles.auth);
  await seedStorage(handles.storage);
}

export async function createSeededSandbox(): Promise<SeededHandles> {
  const sandbox = initializeSandbox();
  const app = initializeApp({ sandbox });

  const adminFirestore = getAdminFirestore(sandbox);
  const firestore = getFirestore(sandbox);
  const auth = getAuth(sandbox);
  const storage = getStorage(app);

  // Seed through the admin (rules-bypass) handle: this is fixture data.
  await applySeed({ adminFirestore, auth, storage });

  // Then drive rules-respecting traffic (allows + denials) so the activity,
  // traffic, and rules surfaces have a real event stream to render.
  await seedTraffic(sandbox, adminFirestore);

  return { sandbox, app, firestore, adminFirestore, auth, storage };
}
