// `node client.cjs` requires the client SDKs from CommonJS, as a bundled
// server route does, and an app with options other than the page's: the host
// keeps one Firebase configuration, so each call rejects with its error and
// nothing throws past the caller.
const { initializeApp } = require("firebase/app");
const { getDatabase, ref, set } = require("firebase/database");
const { getFirestore, doc, setDoc } = require("firebase/firestore");

async function outcome(name, run) {
  try {
    console.log(`${name} ${JSON.stringify({ ok: true, value: (await run()) ?? null })}`);
  } catch (error) {
    console.log(`${name} ${JSON.stringify({ ok: false, code: error?.code ?? null, message: String(error?.message ?? error) })}`);
  }
}

(async () => {
  const options = process.argv[2] === "other-config"
    ? { apiKey: "other", appId: "other", projectId: "demo-app" }
    : {
        apiKey: "demo",
        appId: "demo",
        projectId: "demo-app",
        storageBucket: "demo-app.appspot.com",
        databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
      };
  const app = initializeApp(options);
  await outcome("cjs.database", () => set(ref(getDatabase(app), "server/cjs"), "from require"));
  await outcome("cjs.firestore", () => setDoc(doc(getFirestore(app), "server/cjs"), { from: "require" }));
  // Let any late rejection surface before the process ends.
  await new Promise((resolve) => setTimeout(resolve, 500));
  process.exit(0);
})();
