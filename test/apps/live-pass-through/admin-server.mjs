// The notes app's server job: it looks a user up with the Admin SDK, as a
// full-stack app's server half does, while its pages run in live mode. It
// runs under `node --import @pyric/live/register`.
//
// The Admin SDK gets the app's own credential and an Agent that sends every
// request it makes to a local stand-in for Google, so the run reaches no real
// host. The job then tries the same Google hosts itself, which live mode
// refuses, and prints what each call got.
import { createServer } from "node:http";
import https from "node:https";
import net from "node:net";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";

const PROJECT = "demo-live-pass-through";
const USER = "scenario-user";

/** Google, as the Admin SDK sees it: Auth answers the user lookup. */
const google = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    const isLookup = request.url === `/v1/projects/${PROJECT}/accounts:lookup`;
    response.writeHead(isLookup ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(isLookup ? { users: [{ localId: USER, email: "scenario@example.com" }] } : {}));
  });
});
await new Promise((resolve) => google.listen(0, "127.0.0.1", resolve));
const { port } = google.address();

/** An Agent that keeps each request's Google host but connects to the stand-in, in plain HTTP. */
class StandInGoogleAgent extends https.Agent {
  createConnection() {
    return net.connect({ host: "127.0.0.1", port });
  }
}
const agent = new StandInGoogleAgent({ keepAlive: false });

/** The app's own credential: the Admin SDK asks it for a token, and pyric never sees it. */
const credential = { getAccessToken: async () => ({ access_token: "scenario-access-token", expires_in: 3600 }) };

/** The code an error carries, or its cause's, or its message. */
function codeOf(error) {
  return error?.cause?.code ?? error?.code ?? String(error?.message ?? error);
}

/** The job's own https.request to Auth, through the same Agent. */
function ownRequest() {
  return new Promise((resolve) => {
    const request = https.request(
      { host: "identitytoolkit.googleapis.com", path: `/v1/projects/${PROJECT}/accounts:lookup`, method: "POST", agent },
      (response) => {
        response.resume();
        resolve("sent");
      },
    );
    request.on("error", (error) => resolve(codeOf(error)));
    request.end("{}");
  });
}

const outcome = {};
const app = initializeApp({ projectId: PROJECT, credential, httpAgent: agent });
// FieldValue is @google-cloud/firestore's, which the Admin SDK loads for Firestore.
outcome.firestore = typeof FieldValue.serverTimestamp === "function" ? "loaded" : "missing";
try {
  const user = await getAuth(app).getUser(USER);
  outcome.adminLookup = user.uid;
} catch (error) {
  outcome.adminLookup = codeOf(error);
}
outcome.ownFetch = await fetch("https://oauth2.googleapis.com/token", { method: "POST" }).then(() => "sent", codeOf);
outcome.ownRequest = await ownRequest();
google.close();
console.log(`OUTCOME ${JSON.stringify(outcome)}`);
