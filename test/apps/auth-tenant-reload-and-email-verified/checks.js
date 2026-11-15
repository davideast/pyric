import { initializeApp, deleteApp } from "firebase/app";
import {
  EmailAuthProvider,
  getAuth,
  onAuthStateChanged,
  onIdTokenChanged,
  reauthenticateWithCredential,
  reload,
  signInWithEmailAndPassword,
  updateEmail,
  updatePassword,
  updateProfile,
} from "firebase/auth";
import { getDatabase, ref as dbRef, set as dbSet } from "firebase/database";
import { doc, getFirestore, setDoc } from "firebase/firestore";
import { getStorage, ref as storageRef, uploadString } from "firebase/storage";

async function outcome(op) {
  try {
    await op();
    return "allowed";
  } catch {
    return "denied";
  }
}

async function waitForObservers(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function runChecks(email, nextEmail) {
  const app = initializeApp(
    {
      apiKey: "demo",
      appId: "demo",
      projectId: "demo-app",
      storageBucket: "demo-app.appspot.com",
      databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
    },
    `app-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    const auth = getAuth(app);
    const fs = getFirestore(app);
    const rtdb = getDatabase(app);
    const storage = getStorage(app);

    const cred = await signInWithEmailAndPassword(auth, email, "password123");
    const user = cred.user;

    const beforeVerified = {
      firestore: await outcome(() => setDoc(doc(fs, "verified/before"), { ok: true })),
      rtdb: await outcome(() => dbSet(dbRef(rtdb, "verified/before"), true)),
      storage: await outcome(() => uploadString(storageRef(storage, "verified/before.txt"), "ok")),
    };
    const beforeTenantB = {
      firestore: await outcome(() => setDoc(doc(fs, "tenants/tenant-b/items/before"), { ok: true })),
      rtdb: await outcome(() => dbSet(dbRef(rtdb, "tenants/tenant-b/before"), true)),
      storage: await outcome(() => uploadString(storageRef(storage, "tenants/tenant-b/before.txt"), "ok")),
    };

    // Reassign client-side auth.tenantId after sign-in as a project-level user.
    auth.tenantId = "tenant-b";
    await reload(user);
    const afterReloadToken = await user.getIdTokenResult(false);
    const afterReload = {
      userTenantId: user.tenantId ?? null,
      tokenTenant: afterReloadToken.claims.firebase?.tenant ?? null,
      firestore: await outcome(() => setDoc(doc(fs, "tenants/tenant-b/items/after-reload"), { forged: true })),
      rtdb: await outcome(() => dbSet(dbRef(rtdb, "tenants/tenant-b/after-reload"), "forged")),
      storage: await outcome(() => uploadString(storageRef(storage, "tenants/tenant-b/after-reload.txt"), "forged")),
    };

    // Sibling account mutations while auth.tenantId is set must also keep the session project-level.
    await user.getIdToken(true);
    await updateProfile(user, { displayName: "Updated User" });
    await updatePassword(user, "password456");
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(email, "password456"));
    const afterSiblingToken = await user.getIdTokenResult(false);
    const afterSiblingOps = {
      userTenantId: user.tenantId ?? null,
      tokenTenant: afterSiblingToken.claims.firebase?.tenant ?? null,
      firestore: await outcome(() => setDoc(doc(fs, "tenants/tenant-b/items/after-sibling"), { forged: true })),
      rtdb: await outcome(() => dbSet(dbRef(rtdb, "tenants/tenant-b/after-sibling"), "forged")),
      storage: await outcome(() => uploadString(storageRef(storage, "tenants/tenant-b/after-sibling.txt"), "forged")),
    };

    let authStateFires = 0;
    let idTokenFires = 0;
    const unsubState = onAuthStateChanged(auth, () => {
      authStateFires += 1;
    });
    const unsubToken = onIdTokenChanged(auth, () => {
      idTokenFires += 1;
    });
    await waitForObservers(() => authStateFires >= 1 && idTokenFires >= 1);
    authStateFires = 0;
    idTokenFires = 0;

    // Idempotent same-email update (different casing) keeps emailVerified true and stays silent.
    const tokenBeforeSame = await user.getIdToken(false);
    await updateEmail(user, email.toUpperCase());
    await new Promise((resolve) => setTimeout(resolve, 40));
    const tokenAfterSame = await user.getIdToken(false);
    const afterSameEmail = {
      emailVerified: auth.currentUser?.emailVerified ?? null,
      tokenUnchanged: tokenAfterSame === tokenBeforeSame,
      idTokenFires,
      firestore: await outcome(() => setDoc(doc(fs, "verified/same-email"), { ok: true })),
      rtdb: await outcome(() => dbSet(dbRef(rtdb, "verified/same-email"), true)),
      storage: await outcome(() => uploadString(storageRef(storage, "verified/same-email.txt"), "ok")),
    };

    // Changing email resets emailVerified, refreshes the token immediately, and denies verified-only rules.
    await updateEmail(user, nextEmail);
    await waitForObservers(() => idTokenFires >= 1, 1000);
    unsubState();
    unsubToken();

    const afterUpdateToken = await user.getIdTokenResult(false);
    const afterEmailChange = {
      userEmail: user.email,
      userEmailVerified: user.emailVerified,
      currentUserEmailVerified: auth.currentUser?.emailVerified ?? null,
      tokenChanged: afterUpdateToken.token !== tokenBeforeSame,
      tokenEmail: afterUpdateToken.claims.email ?? null,
      tokenEmailVerified: afterUpdateToken.claims.email_verified ?? null,
      tokenTenant: afterUpdateToken.claims.firebase?.tenant ?? null,
      authStateFires,
      idTokenFires,
      verifiedFirestore: await outcome(() => setDoc(doc(fs, "verified/after-email"), { ok: true })),
      verifiedRtdb: await outcome(() => dbSet(dbRef(rtdb, "verified/after-email"), true)),
      verifiedStorage: await outcome(() => uploadString(storageRef(storage, "verified/after-email.txt"), "nope")),
      tenantBFirestore: await outcome(() => setDoc(doc(fs, "tenants/tenant-b/items/after-email"), { forged: true })),
      tenantBRtdb: await outcome(() => dbSet(dbRef(rtdb, "tenants/tenant-b/after-email"), "forged")),
      tenantBStorage: await outcome(() => uploadString(storageRef(storage, "tenants/tenant-b/after-email.txt"), "forged")),
    };

    return {
      beforeVerified,
      beforeTenantB,
      afterReload,
      afterSiblingOps,
      afterSameEmail,
      afterEmailChange,
    };
  } finally {
    await deleteApp(app);
  }
}
