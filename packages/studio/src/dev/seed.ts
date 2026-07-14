/**
 * Dev-seed (Phase 0, F-SHELL): an in-page seeded sandbox so Studio renders for
 * review WITHOUT a live `pyric dev`.
 *
 * It builds one `Sandbox` via `initializeSandbox()` and populates it through the
 * modular SDKs exactly as a real app would:
 *   - Firestore: a `notes` collection (~12 docs, incl. nested map / array /
 *     geopoint / timestamp / reference fields), plus `users` and `posts`.
 *     Writes go through the ADMIN handle (`getAdminFirestore`) so the seed
 *     bypasses rules; it's a fixture, not an app action.
 *   - Auth: admin-created users via `sandbox.createUser`, plus an anonymous
 *     account created through the client sign-in flow.
 *   - Storage: a couple of objects (an avatar PNG + a text note attachment).
 *
 * Everything here is import-gated behind `import.meta.env.DEV` at the call site
 * (`DevSeedProvider`) so it is tree-shaken out of production builds.
 */

import type { FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import {
  GeoPoint,
  Timestamp,
  doc,
  getAdminFirestore,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore,
} from 'pyric/firestore';
import {
  getAuth,
  sandbox as authSandbox,
  signInAnonymously,
  signOut,
  type Auth,
} from 'pyric/auth';
import { ref, uploadBytes, type FirebaseStorage } from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { studioAdminContext } from '../shell/studio-operation-context.js';

/** The resolved handles a seeded Studio sandbox exposes to surfaces. */
export interface SeededHandles {
  sandbox: LocalSandbox;
  app: FirebaseApp;
  /** Rules-respecting handle (what the running app sees). */
  firestore: Firestore;
  /** Rules-bypass handle ("edit anything" / admin lens). */
  adminFirestore: Firestore;
  auth: Auth;
  storage: FirebaseStorage;
}

/** Three admin-created users plus one real anonymous sign-in. Provider
 * provenance lives in Auth's provider fields, never in custom claims. */
export async function seedAuth(auth: Auth): Promise<void> {
  authSandbox.createUser(auth, {
    uid: 'alice',
    email: 'alice@gmail.com',
    displayName: 'Alice Nguyen',
    emailVerified: true,
    photoUrl: 'https://lh3.googleusercontent.com/a/alice',
    providerUserInfo: [{ providerId: 'google.com' }],
    customClaims: { plan: 'pro' },
  });
  authSandbox.createUser(auth, {
    uid: 'bob',
    email: 'bob@example.com',
    password: 'pyric-demo',
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
  // Anonymous accounts are born through sign-in. Admin createUser with no
  // email is still a non-anonymous account and must not be presented as one.
  await signInAnonymously(auth);
  await signOut(auth);
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
async function seedTraffic(sandbox: LocalSandbox): Promise<void> {
  setRules(sandbox, RULES);

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
  await seedAuth(handles.auth);
  await seedStorage(handles.storage);
}

let seedAppSeq = 0;

export async function createSeededSandbox(): Promise<SeededHandles> {
  const sandbox = initializeSandbox();
  // Unique app name: pyric/app mirrors firebase's registry (a repeated default
  // name throws app/duplicate-app), so each seeded sandbox gets its own.
  const app = createAppForSandbox(sandbox, { projectId: 'pyric-studio' }, `pyric-seed-${seedAppSeq++}`);

  const studioContext = studioAdminContext(sandbox);
  const adminFirestore = getAdminFirestore(studioContext);
  const firestore = getFirestore(sandbox);
  const auth = getAuth(sandbox);
  const storage = getAdminStorageSandbox(studioContext);

  // Seed through the admin (rules-bypass) handle: this is fixture data.
  await applySeed({ adminFirestore, auth, storage });

  // Then drive rules-respecting traffic (allows + denials) so the activity,
  // traffic, and rules surfaces have a real event stream to render.
  await seedTraffic(sandbox);

  return { sandbox, app, firestore, adminFirestore, auth, storage };
}
