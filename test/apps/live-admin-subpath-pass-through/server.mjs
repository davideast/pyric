// The orders API's backend, as #2445's report runs it under
// `node --import @pyric/live/register`: middleware verifies each request's
// App Check token with firebase-admin/app-check, and a new order sends a push
// notification with firebase-admin/messaging.
//
// The Admin SDK's Agent keeps each request's Google host but connects to a
// local stand-in for Google, so the guard still judges each request by its
// Google host. The stand-in serves App Check's public keys and FCM's send.
// `trap.mjs` fails any other host lookup, so no request reaches a real host.
// The job prints what each call got on its OUTCOME line.
import { trapped } from "./trap.mjs";
import { createSign, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import https from "node:https";
import net from "node:net";
import { initializeApp } from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";
import { getMessaging } from "firebase-admin/messaging";

const PROJECT = "demo-admin-subpaths";
const APP_ID = "1:123456789012:web:0a1b2c3d4e5f6071";
const KID = "stand-in-key";

/** App Check's signing key, as its public JWKS serves it. */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }] };

/** Google, as the Admin SDK sees it: App Check's keys and FCM's send API. */
const google = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    const isKeys = request.url === "/v1/jwks";
    const isSend = request.url === `/v1/projects/${PROJECT}/messages:send`;
    const body = isKeys ? jwks : isSend ? { name: `projects/${PROJECT}/messages/stand-in-1` } : {};
    response.writeHead(isKeys || isSend ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
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
const credential = { getAccessToken: async () => ({ access_token: "stand-in-access-token", expires_in: 3600 }) };

/** The code an error carries, or its cause's, or its message. */
function codeOf(error) {
  return error?.cause?.code ?? error?.code ?? String(error?.message ?? error);
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A client's App Check token, as App Check signs it. */
function appCheckToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = base64url({
    iss: "https://firebaseappcheck.googleapis.com/123456789012",
    sub: APP_ID,
    aud: ["projects/123456789012", `projects/${PROJECT}`],
    iat: now,
    exp: now + 3600,
  });
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey, "base64url");
  return `${header}.${payload}.${signature}`;
}

/** The backend's own request to a Google host, through the same Agent. */
function ownRequest(host, path) {
  return new Promise((resolve) => {
    const request = https.request({ host, path, method: "GET", agent }, (response) => {
      response.resume();
      resolve("sent");
    });
    request.on("error", (error) => resolve(codeOf(error)));
    request.end();
  });
}

const outcome = {};
const app = initializeApp({ projectId: PROJECT, credential, httpAgent: agent });
try {
  outcome.appCheck = (await getAppCheck(app).verifyToken(appCheckToken())).appId;
} catch (error) {
  outcome.appCheck = codeOf(error);
}
const messaging = getMessaging(app);
// FCM's HTTP/2 transport ignores the Agent; the HTTP/1.1 one sends through it.
messaging.enableLegacyHttpTransport();
try {
  outcome.messaging = await messaging.send({ topic: "orders", notification: { title: "New order" } });
} catch (error) {
  outcome.messaging = codeOf(error);
}
outcome.ownAppCheck = await ownRequest("firebaseappcheck.googleapis.com", "/v1/jwks");
outcome.ownFcm = await ownRequest("fcm.googleapis.com", `/v1/projects/${PROJECT}/messages:send`);
outcome.trapped = [...new Set(trapped)];
google.close();
console.log(`OUTCOME ${JSON.stringify(outcome)}`);
process.exit(0);
