// The notes app's API server, the backend half of a full-stack app. The page
// sends `POST /api/notes` with its ID token as a bearer token. The server
// checks the token with the Admin SDK, then saves the note in Firestore, fans
// it out to the Realtime Database, and keeps a copy in Cloud Storage. It runs
// under `node --import @pyric/live/register`, and reaches its backend through
// firebase-admin's own emulator variables, which the scenario points at a
// local stand-in for production.
import { createServer } from "node:http";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const PROJECT = process.env.NOTES_PROJECT;
const PORT = Number(process.env.NOTES_API_PORT);
const RUN = "pyric_oracle/replay";

const app = initializeApp({
  projectId: PROJECT,
  databaseURL: `https://${PROJECT}-default-rtdb.firebaseio.com`,
  storageBucket: `${PROJECT}.firebasestorage.app`,
});
const auth = getAuth(app);
const db = getFirestore(app);
const database = getDatabase(app);
const bucket = getStorage(app).bucket();

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function saveNote(request, response) {
  const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
  let uid;
  try {
    uid = (await auth.verifyIdToken(token)).uid;
  } catch (error) {
    send(response, 401, { code: error.code ?? null, pyricCode: error.pyricCode ?? null });
    return;
  }
  const note = await readJson(request);
  await db.doc(`${RUN}/notes/a`).set({ n: note.n });
  await database.ref(RUN).update({ b: 2 });
  await bucket.file(`${RUN}/note.txt`).save("capture text", { resumable: false, contentType: "text/plain" });
  send(response, 200, { uid, saved: true });
}

const server = createServer((request, response) => {
  if (request.method === "POST" && request.url === "/api/notes") {
    saveNote(request, response).catch((error) => send(response, 500, { error: String(error?.code ?? error?.message ?? error) }));
    return;
  }
  request.resume();
  send(response, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`notes api listening on ${PORT}`);
});
