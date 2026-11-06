// An items app's client code, the same module on the page and in its server
// job. On each Realtime Database instance, the default and `named`, two
// users sign in with custom tokens. The first writes, reads, updates, pushes,
// runs a transaction, listens to a value and a list the second user changes,
// is denied /secret, and sets an onDisconnect write the second user reads
// once the first goes offline. Its backend is production, or the local one a
// `?backend=<origin>` query (the page) or APP_BACKEND (the server job) names,
// through the SDK's own emulator connectors.
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithCustomToken, signOut } from "firebase/auth";
import {
  connectDatabaseEmulator, get, getDatabase, goOffline, onChildAdded, onDisconnect, onValue, push, ref, runTransaction, set, update,
} from "firebase/database";

const PROJECT = "demo-live-rtdb";
const config = {
  projectId: PROJECT,
  apiKey: "demo-live-rtdb-key",
  appId: "1:1:web:live-rtdb",
  authDomain: `${PROJECT}.firebaseapp.com`,
  databaseURL: `https://${PROJECT}-default-rtdb.firebaseio.com`,
};
/** Where each instance's paths live: the run folder the app writes under. */
const RUN = "pyric-live-capture/replay";
const isPage = typeof window === "object";
const backend = isPage ? new URLSearchParams(location.search).get("backend") : process.env.APP_BACKEND;

/** User `n` on one instance: its own app, signed in with its custom token. */
async function client(label, n) {
  const app = initializeApp(config, `${label}-${n}`);
  const auth = getAuth(app);
  const url = backend ? new URL(backend) : null;
  if (url) connectAuthEmulator(auth, url.origin, { disableWarnings: true });
  const credential = await signInWithCustomToken(auth, `client-${n}`);
  const db = label === "default" ? getDatabase(app) : getDatabase(app, `https://${PROJECT}-${label}.firebaseio.com`);
  if (url) connectDatabaseEmulator(db, url.hostname, Number(url.port));
  return { app, db, uid: credential.user.uid };
}

const until = async (done) => {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 10));
};

/** Resolves once the instance's connection is up, as `.info/connected` reports it. */
const connected = (db) => new Promise((resolve) => {
  const stop = onValue(ref(db, ".info/connected"), (snapshot) => {
    if (snapshot.val() !== true) return;
    stop();
    resolve();
  });
});

const failure = (error) => error.message;

async function runOn(label, first) {
  const one = await client(label, first);
  const two = await client(label, first + 1);
  const at = (db, path) => ref(db, `${RUN}/${path}`);
  const result = { uids: [one.uid, two.uid] };
  await connected(one.db);
  await connected(two.db);
  await set(at(one.db, "items/a"), { n: 1, s: "alpha" });
  result.get = (await get(at(one.db, "items/a"))).val();
  await update(at(one.db, "items/a"), { n: 2, flag: true });
  const pushed = [(await push(at(one.db, "list"), { v: 1 })).key];
  const outcome = await runTransaction(at(one.db, "counter"), (current) => (current ?? 0) + 1);
  result.runTransaction = { committed: outcome.committed, value: outcome.snapshot.val() };

  const values = [];
  const stopValue = onValue(at(one.db, "items/a"), (snapshot) => { values.push(snapshot.val()); });
  await until(() => values.length === 1);
  await set(at(two.db, "items/a/n"), 3);
  await until(() => values.length === 2);
  stopValue();
  result.onValue = values;

  const children = [];
  const stopChild = onChildAdded(at(one.db, "list"), (snapshot) => { children.push(snapshot.key); });
  await until(() => children.length === 1);
  pushed.push((await push(at(two.db, "list"), { v: 2 })).key);
  await until(() => children.length === 2);
  stopChild();
  result.onChildAdded = children.length === 2 && children.every((key, index) => key === pushed[index]);

  result.deniedRead = await get(ref(one.db, "secret")).then(() => "allowed", failure);
  result.deniedWrite = await set(ref(one.db, "secret"), "x").then(() => "allowed", failure);

  await set(at(one.db, "presence"), "online");
  await onDisconnect(at(one.db, "presence")).set("offline");
  goOffline(one.db);
  result.presence = (await get(at(two.db, "presence"))).val();
  goOffline(two.db);
  return { result, apps: [one.app, two.app] };
}

/** Both instances in turn: users 1 and 2 on the default, 3 and 4 on the named one. */
async function runApp() {
  const results = {};
  const apps = [];
  for (const [index, label] of ["default", "named"].entries()) {
    const run = await runOn(label, index * 2 + 1);
    results[label] = run.result;
    apps.push(...run.apps);
  }
  return { results, apps };
}

if (isPage) {
  window.runApp = () => runApp().then((run) => run.results, (error) => `failed: ${error.code ?? ""} ${error.message}`);
  document.querySelector("#status").textContent = "Ready";
} else {
  const { results, apps } = await runApp();
  // Signing out stops each user's token refresh timer, which would keep the process running.
  for (const app of apps) {
    await signOut(getAuth(app));
    await deleteApp(app);
  }
  console.log(`RESULT ${JSON.stringify(results)}`);
}
