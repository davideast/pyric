import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, set } from "firebase/database";

// The databaseURL the Firebase console gives an app of a project created
// before about 2020: the default instance, named by the project id.
const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "legacy-app",
  databaseURL: "https://legacy-app.firebaseio.com",
});
const db = getDatabase(app);
// Pyric runs one Firebase configuration per runtime, so the instance an app
// without a databaseURL uses is opened by the URL the SDK derives for it.
const projectDefault = getDatabase(app, "https://legacy-app-default-rtdb.firebaseio.com");

async function outcome(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

window.legacy = {
  write: (path, value) => outcome(() => set(ref(db, path), value).then(() => null)),
  read: (path) => outcome(async () => (await get(ref(db, path))).val()),
  readProjectDefault: (path) => outcome(async () => (await get(ref(projectDefault, path))).val()),
};
