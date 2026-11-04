// The app's API: a server started with `node --import @pyric/cli/register`. It
// reads the ID token from the Authorization header the usual way, splitting
// on the space, verifies it with firebase-admin, and answers the caller's uid
// and name. GET /self signs in through firebase/auth from this process and
// calls /whoami with its own token, as a server-rendered route does.
//
// GET /custom-token mints a custom token for a uid with a developer claim, as
// a backend that bridges its own accounts into Firebase does (#1952). With
// ?project=other it mints from an admin app for another project. GET /claims
// verifies a Bearer token and answers its uid and role claim. GET
// /self-custom exchanges a custom token from this process and verifies the
// ID token it gets back.
import { createServer } from "node:http";
import { initializeApp as initializeAdminApp } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { initializeApp } from "firebase/app";
import { createUserWithEmailAndPassword, getAuth, signInWithCustomToken, signOut, updateProfile } from "firebase/auth";

const port = Number(process.env.API_PORT);
const apiUrl = `http://127.0.0.1:${port}`;

initializeAdminApp({ projectId: "demo-bearer" });
const otherProjectAdmin = initializeAdminApp({ projectId: "demo-other-project" }, "other-project");
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

async function customToken(request, response) {
  const url = new URL(request.url, apiUrl);
  const admin = url.searchParams.get("project") === "other" ? getAdminAuth(otherProjectAdmin) : getAdminAuth();
  const token = await admin.createCustomToken(url.searchParams.get("uid") ?? "", { role: "editor" });
  send(response, 200, { token });
}

async function claims(request, response) {
  const idToken = (request.headers.authorization ?? "").split(" ")[1] ?? "";
  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    send(response, 200, { uid: decoded.uid, role: decoded.role ?? null, provider: decoded.firebase.sign_in_provider });
  } catch (error) {
    send(response, 401, { error: String(error?.message ?? error) });
  }
}

async function selfCustom(response) {
  try {
    const auth = getAuth(clientApp);
    await signOut(auth);
    const token = await getAdminAuth().createCustomToken("server-custom-uid", { role: "editor" });
    const { user } = await signInWithCustomToken(auth, token);
    const idToken = await user.getIdToken();
    const answer = await fetch(`${apiUrl}/claims`, { headers: { Authorization: `Bearer ${idToken}` } });
    send(response, 200, { uid: user.uid, answer: { status: answer.status, body: await answer.json() } });
  } catch (error) {
    send(response, 200, { threw: String(error?.message ?? error) });
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
  if (request.url === "/self-custom") return void selfCustom(response);
  if (request.url === "/claims") return void claims(request, response);
  if (request.url.startsWith("/custom-token")) return void customToken(request, response);
  send(response, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1", () => console.log(`api-server listening on ${port}`));
