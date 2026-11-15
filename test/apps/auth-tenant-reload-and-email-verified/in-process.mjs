import { readFileSync } from "node:fs";
import { initializeSandbox } from "pyric/sandbox";
import { getFirestore as getAdminFirestore } from "pyric/sandbox/admin-firestore";
import { setRules as setDatabaseRules } from "pyric/sandbox/database";
import {
  EmailAuthProvider,
  getAuth,
  onAuthStateChanged,
  onIdTokenChanged,
  reauthenticateWithCredential,
  reload,
  sandbox as authSandbox,
  signInWithEmailAndPassword,
  updateEmail,
  updatePassword,
  updateProfile,
} from "pyric/auth";
import { getDatabase, ref as dbRef, set as dbSet } from "pyric/database";
import { doc, getFirestore, setDoc } from "pyric/firestore";
import { getStorageSandbox, ref as storageRef, uploadString } from "pyric/storage";

async function outcome(op) {
  try {
    await op();
    return "allowed";
  } catch {
    return "denied";
  }
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const firestoreRules = readFileSync(new URL("./firestore.rules", import.meta.url), "utf8");
const rtdbRules = JSON.parse(readFileSync(new URL("./database.rules.json", import.meta.url), "utf8"));
const storageRules = readFileSync(new URL("./storage.rules", import.meta.url), "utf8");

const sandbox = initializeSandbox();
getAdminFirestore(sandbox.withAuth(null)).setRules(firestoreRules);
setDatabaseRules(sandbox, rtdbRules);
const storage = getStorageSandbox(sandbox, { rules: storageRules });
const fs = getFirestore(sandbox);
const rtdb = getDatabase(sandbox);
const auth = getAuth(sandbox);

const email = "inproc@example.com";
const nextEmail = "inproc-next@example.com";
authSandbox.createUser(auth, {
  email,
  password: "password123",
  emailVerified: true,
});

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
await flush();
authStateFires = 0;
idTokenFires = 0;

const tokenBeforeSame = await user.getIdToken(false);
await updateEmail(user, email.toUpperCase());
await flush();
const tokenAfterSame = await user.getIdToken(false);
const afterSameEmail = {
  emailVerified: auth.currentUser?.emailVerified ?? null,
  tokenUnchanged: tokenAfterSame === tokenBeforeSame,
  idTokenFires,
  firestore: await outcome(() => setDoc(doc(fs, "verified/same-email"), { ok: true })),
  rtdb: await outcome(() => dbSet(dbRef(rtdb, "verified/same-email"), true)),
  storage: await outcome(() => uploadString(storageRef(storage, "verified/same-email.txt"), "ok")),
};

await updateEmail(user, nextEmail);
await flush();
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

console.log(
  `checks ${JSON.stringify({
    beforeVerified,
    beforeTenantB,
    afterReload,
    afterSiblingOps,
    afterSameEmail,
    afterEmailChange,
  })}`,
);
process.exit(0);
