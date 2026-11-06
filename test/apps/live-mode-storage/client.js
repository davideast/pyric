// A files app's client code, the same module on the page and in its server
// job. On the default bucket and a second one, two users sign in with custom
// tokens and a third client stays signed out. The first user uploads (bytes,
// strings, a resumable upload and one it pauses and resumes), reads metadata,
// a download URL and the bytes, updates metadata, lists a page at a time and
// a whole prefix, and deletes every object, then misses an object that is not
// there. The second user reads metadata and is denied an upload, a download
// and a list; the signed-out client is denied an upload. Its backend is
// production, or the local one a `?backend=<origin>` query (the page) or
// APP_BACKEND (the server job) names, through the SDK's own emulator
// connectors.
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithCustomToken, signOut } from "firebase/auth";
import {
  connectStorageEmulator, deleteObject, getBytes, getDownloadURL, getMetadata, getStorage, getStream, list, listAll, ref,
  updateMetadata, uploadBytes, uploadBytesResumable, uploadString,
} from "firebase/storage";

const PROJECT = "demo-live-storage";
const config = {
  projectId: PROJECT,
  apiKey: "demo-live-storage-key",
  appId: "1:1:web:live-storage",
  authDomain: `${PROJECT}.firebaseapp.com`,
  storageBucket: `${PROJECT}.firebasestorage.app`,
};
const SECOND_BUCKET = `${PROJECT}-live-second`;
/** Where each bucket's objects live: the run folder the app writes under, and one its rules deny. */
const RUN = "pyric_oracle/replay";
const DENIED = "pyric_oracle_denied_storage/replay";
const SIX_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6]);
/** About 600 KiB: a resumable upload sends it in two chunks, and the paused one in three. */
const LARGE = Uint8Array.from({ length: 600 * 1024 }, (_, i) => i % 251);
const OBJECTS = ["a.bin", "raw.txt", "b64.bin", "big.bin", "paused.bin", "nested/x/one.txt", "nested/two.txt"];
const isPage = typeof window === "object";
const backend = isPage ? new URLSearchParams(location.search).get("backend") : process.env.APP_BACKEND;

/** A client of `bucket`, signed in as user `n` with its custom token, or signed out when `n` is null. */
async function client(bucket, n) {
  const app = initializeApp(config, `${bucket}-${n ?? "signed-out"}`);
  const url = backend ? new URL(backend) : null;
  if (n !== null) {
    const auth = getAuth(app);
    if (url) connectAuthEmulator(auth, url.origin, { disableWarnings: true });
    await signInWithCustomToken(auth, `client-${n}`);
  }
  const storage = bucket === "default" ? getStorage(app) : getStorage(app, `gs://${SECOND_BUCKET}`);
  if (url) connectStorageEmulator(storage, url.hostname, Number(url.port));
  return { app, storage, signedIn: n !== null };
}

/**
 * Each bucket's paused upload a page is running, until `pauseHeldUpload`
 * pauses it. In Node the SDK makes the next chunk's request within the turn
 * the first chunk's answer arrives, so a pause on the next turn cancels that
 * request before it is sent, and the resume asks the server what it received,
 * as capture S recorded. A page resolves the next chunk's token in a later
 * task, so no timer lands reliably in that window; the page's paused upload
 * waits for whoever drives it to call `pauseHeldUpload` while the next chunk
 * is in flight.
 */
const pausable = new Map();

/** Pauses the upload running on `bucket` that waits for it. */
function pauseHeldUpload(bucket) {
  const task = pausable.get(bucket);
  if (!task) return false;
  pausable.delete(bucket);
  task.pause();
  return true;
}

/** Uploads `LARGE` resumably, pausing once after the first chunk and resuming once paused. */
async function pausedUpload(at) {
  const task = uploadBytesResumable(at, LARGE);
  let pauseScheduled = isPage;
  let resumed = false;
  let paused = false;
  if (isPage) pausable.set(at.bucket, task);
  task.on("state_changed", (snapshot) => {
    if (!pauseScheduled && snapshot.bytesTransferred > 0 && snapshot.state === "running") {
      pauseScheduled = true;
      setTimeout(() => task.pause(), 0);
    }
    if (!resumed && snapshot.state === "paused") {
      paused = true;
      resumed = true;
      task.resume();
    }
  });
  await task;
  return paused;
}

const names = (refs) => refs.map((item) => item.fullPath.slice(RUN.length + 1));

/** The sequence on one bucket: each step's outcome, ok or the SDK's code. */
async function runOn(bucket) {
  const one = await client(bucket, 1);
  const two = await client(bucket, 2);
  const signedOut = await client(bucket, null);
  const at = (c, path) => ref(c.storage, `${RUN}/${path}`);
  const denied = (c, path) => ref(c.storage, `${DENIED}/${path}`);
  const root = ref(one.storage, RUN);
  const result = {};
  const step = async (name, run) => {
    try {
      result[name] = (await run()) ?? "ok";
    } catch (error) {
      result[name] = error.code ?? String(error);
    }
  };
  await step("preflight", async () => (await listAll(root)).items.length);
  await step("uploadBytes", async () => (await uploadBytes(at(one, "a.bin"), SIX_BYTES)).metadata.size);
  await step("uploadString-raw", async () => (await uploadString(at(one, "raw.txt"), "capture s", "raw")).metadata.size);
  await step("uploadString-base64", async () => (await uploadString(at(one, "b64.bin"), "Y2FwdHVyZSBz", "base64")).metadata.size);
  await step("uploadBytesResumable", async () => (await uploadBytesResumable(at(one, "big.bin"), LARGE)).metadata.size);
  await step("uploadBytesResumable-paused", () => pausedUpload(at(one, "paused.bin")).then((paused) => (paused ? "paused and resumed" : "never paused")));
  await step("getMetadata", async () => (await getMetadata(at(one, "a.bin"))).size);
  await step("getDownloadURL", async () => new URL(await getDownloadURL(at(one, "a.bin"))).searchParams.has("token"));
  await step("getBytes", async () => (await getBytes(at(one, "a.bin"))).byteLength);
  // The browser build has no getStream. In Node the job reads the stream to
  // its end: a stream never read to the end leaves its record pending.
  if (!isPage) await step("getStream", async () => (await new Response(getStream(at(one, "a.bin"))).arrayBuffer()).byteLength);
  await step("updateMetadata", async () => (await updateMetadata(at(one, "a.bin"), { cacheControl: "no-store", customMetadata: { capture: "s" } })).cacheControl);
  await step("setup-nested", async () => {
    await uploadString(at(one, "nested/x/one.txt"), "one", "raw");
    await uploadString(at(one, "nested/two.txt"), "two", "raw");
  });
  await step("list", async () => {
    const first = await list(root, { maxResults: 2 });
    const second = await list(root, { maxResults: 2, pageToken: first.nextPageToken });
    return [names(first.items), names(second.items), names(second.prefixes)];
  });
  await step("listAll", async () => {
    const nested = await listAll(at(one, "nested"));
    return [names(nested.items), names(nested.prefixes)];
  });
  await step("getMetadata-second-account", async () => (await getMetadata(at(two, "a.bin"))).size);
  await step("deleteObject", async () => {
    for (const path of OBJECTS) await deleteObject(at(one, path));
  });
  await step("getMetadata-missing", () => getMetadata(at(one, "missing.bin")));
  await step("deleteObject-missing", () => deleteObject(at(one, "missing.bin")));
  await step("denied-upload", () => uploadBytes(denied(two, "forbidden.bin"), SIX_BYTES));
  await step("denied-getBytes", () => getBytes(denied(two, "forbidden.bin")));
  await step("denied-list", () => list(denied(two, "")));
  await step("signed-out-upload", () => uploadBytes(at(signedOut, "signed-out.bin"), SIX_BYTES));
  await step("cleanup", async () => {
    const left = [];
    for (let pass = 0; pass < 2; pass++) left.push((await listAll(root)).items.length);
    return left;
  });
  return { result, clients: [one, two, signedOut] };
}

/** Both buckets in turn, the default first. */
async function runApp() {
  const results = {};
  const clients = [];
  for (const bucket of ["default", "second"]) {
    const run = await runOn(bucket);
    results[bucket] = run.result;
    clients.push(...run.clients);
  }
  return { results, clients };
}

/** One upload to the default bucket as a signed-out client, its metadata's bucket or the error code. */
async function uploadNote(path) {
  const { storage } = await client("default", null);
  return uploadBytes(ref(storage, path), SIX_BYTES).then((uploaded) => uploaded.metadata.bucket, (error) => error.code);
}

if (isPage) {
  window.runApp = () => runApp().then((run) => run.results, (error) => `failed: ${error.code ?? ""} ${error.message}`);
  window.uploadNote = uploadNote;
  window.pauseHeldUpload = pauseHeldUpload;
  document.querySelector("#status").textContent = "Ready";
} else {
  const { results, clients } = await runApp();
  // Signing out stops each user's token refresh timer, which would keep the process running.
  for (const { app, signedIn } of clients) {
    if (signedIn) await signOut(getAuth(app));
    await deleteApp(app);
  }
  console.log(`RESULT ${JSON.stringify(results)}`);
}
