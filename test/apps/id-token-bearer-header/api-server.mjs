// The app's API: a server started with `node --import @pyric/cli/register`. It
// reads the ID token from the Authorization header the usual way, splitting
// on the space, verifies it with firebase-admin, and answers the caller's uid
// and name. GET /self signs in through firebase/auth from this process and
// calls /whoami with its own token, as a server-rendered route does.
import { createServer } from "node:http";
import { initializeApp as initializeAdminApp } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { initializeApp } from "firebase/app";
import { createUserWithEmailAndPassword, getAuth, updateProfile } from "firebase/auth";

const port = Number(process.env.API_PORT);
const apiUrl = `http://127.0.0.1:${port}`;

initializeAdminApp({ projectId: "demo-bearer" });
const clientApp = initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-bearer" });

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  response.end(JSON.stringify(body));
}

async function whoami(request, response) {
  const idToken = (request.headers.authorization ?? "").split(" ")[1] ?? "";
  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    send(response, 200, { uid: decoded.uid, name: decoded.name ?? null, aud: decoded.aud, iss: decoded.iss });
  } catch (error) {
    send(response, 401, { error: String(error?.message ?? error) });
  }
}

async function self(response) {
  try {
    const { user } = await createUserWithEmailAndPassword(getAuth(clientApp), "server@example.com", "secret-pw");
    await updateProfile(user, { displayName: "Builder One" });
    const idToken = await user.getIdToken(true);
    const answer = await fetch(`${apiUrl}/whoami`, { headers: { Authorization: `Bearer ${idToken}` } });
    send(response, 200, { uid: user.uid, answer: { status: answer.status, body: await answer.json() } });
  } catch (error) {
    send(response, 200, { threw: String(error?.message ?? error) });
  }
}

const server = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization",
    });
    response.end();
    return;
  }
  if (request.url === "/whoami") return void whoami(request, response);
  if (request.url === "/self") return void self(response);
  send(response, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1", () => console.log(`api-server listening on ${port}`));
