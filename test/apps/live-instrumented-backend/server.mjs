// The orders API's backend: a Node server that loads request instrumentation
// first, then uses firebase-admin with the app's own credentials, as #2445's
// report runs it under `node --import @pyric/live/register`.
//
// Every request the Admin SDK makes with its Agent keeps its Google host but
// connects to a local stand-in for Google. Every other connection reaches the
// scenario's trap (`trap.mjs`), which fails its host lookup and records the
// host: the run reaches no real host. The job prints what each call got, and
// its own process health, on its OUTCOME line.
import { trapped } from "./trap.mjs";
import { instrumented } from "./instrument.mjs";
import { generateKeyPairSync } from "node:crypto";
import http, { createServer } from "node:http";
import https from "node:https";
import net from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";

const PROJECT = "demo-instrumented-backend";
const USER = "order-owner";
const TOKEN = "stand-in-access-token";

/** What the stand-in answered, by path. */
const answered = [];

/** Google, as the Admin SDK sees it: the token endpoints and Auth's user lookup. */
const google = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    const path = new URL(request.url, "http://stand-in").pathname;
    answered.push(path);
    const isToken = path.endsWith("/token") || path.endsWith(":generateAccessToken");
    const isLookup = path === `/v1/projects/${PROJECT}/accounts:lookup`;
    const body = isToken ? { access_token: TOKEN, expires_in: 3600, token_type: "Bearer" } : { users: [{ localId: USER }] };
    response.writeHead(isToken || isLookup ? 200 : 404, { "content-type": "application/json" });
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

/** The code an error carries, or its cause's, or its message. */
function codeOf(error) {
  return error?.cause?.code ?? error?.code ?? String(error?.message ?? error);
}

/** Application Default Credentials: a user's refresh token, exchanged at oauth2.googleapis.com. */
const adcFile = join(process.cwd(), "adc.json");
writeFileSync(adcFile, JSON.stringify({ type: "authorized_user", client_id: "stand-in-client", client_secret: "stand-in-secret", refresh_token: "stand-in-refresh" }));
process.env.GOOGLE_APPLICATION_CREDENTIALS = adcFile;

/**
 * A service-account key, signed here and exchanged at www.googleapis.com's
 * token path. google-auth-library sends that exchange without the Agent, so
 * the trap records it.
 */
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = {
  projectId: PROJECT,
  clientEmail: `orders-api@${PROJECT}.iam.gserviceaccount.com`,
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
};

async function lookup(app) {
  try {
    return (await getAuth(app).getUser(USER)).uid;
  } catch (error) {
    return codeOf(error);
  }
}

/** The backend's own https.request to `host`, through the instrumentation and the Agent. */
function ownRequest(host, path) {
  return new Promise((resolve) => {
    const request = https.request({ host, path, method: "POST", agent }, (response) => {
      response.resume();
      resolve("sent");
    });
    request.on("error", (error) => resolve(codeOf(error)));
    request.end("{}");
  });
}

/** The backend's own fetch: it goes out, and the trap fails its lookup. */
function ownFetch(url) {
  return fetch(url, { method: "POST", body: "{}" }).then(() => "sent", codeOf);
}

/**
 * A custom credential: app code the Admin SDK calls for each token. Its own
 * requests start inside that call, with the Admin SDK's frames beneath them,
 * and go out as they would without pyric.
 */
const callbackRequests = [];
const callbackCredential = {
  async getAccessToken() {
    const sent = await Promise.all([
      ownRequest("iamcredentials.googleapis.com", `/v1/projects/-/serviceAccounts/orders-api@${PROJECT}.iam.gserviceaccount.com:generateAccessToken`),
      ownFetch("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/orders-api:generateAccessToken"),
    ]);
    callbackRequests.push(...sent);
    return { access_token: TOKEN, expires_in: 3600 };
  },
};

/** Opens a reference on the app's Realtime Database, then takes it offline: ok, or the refusal's code. */
function openDatabase(app) {
  try {
    const database = getDatabase(app);
    database.ref("orders/a");
    database.goOffline();
    return "ok";
  } catch (error) {
    return codeOf(error);
  }
}

/** This process's health, as the live host's proxy check reads it. */
async function processHealth() {
  const server = createServer((_request, response) => response.end("app"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: healthPort } = server.address();
  const body = await new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: healthPort, path: "/__pyric/health", headers: { "x-pyric-process-health": "1" } }, (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => resolve(text));
    });
    request.on("error", reject);
  });
  server.close();
  return JSON.parse(body).pyricProcess;
}

const outcome = { instrument: instrumented.mode };
const adcApp = initializeApp({ projectId: PROJECT, credential: applicationDefault(agent), httpAgent: agent }, "adc");
const certApp = initializeApp({ projectId: PROJECT, credential: cert(serviceAccount, agent), httpAgent: agent }, "cert");
outcome.adcLookup = await lookup(adcApp);
// The service-account exchange fails at the trap, so the lookup does too; what counts is that it went out.
await lookup(certApp);
outcome.tokenExchanges = answered.filter((path) => path.endsWith("/token")).length;
outcome.instrumented = instrumented.requests > 0;

const callbackApp = initializeApp({ projectId: PROJECT, credential: callbackCredential, httpAgent: agent }, "callback");
outcome.callbackLookup = await lookup(callbackApp);
outcome.callbackRequests = callbackRequests;

// The backend's own Google calls: Vertex AI, Cloud Trace, and App Check's public keys.
outcome.vertex = await ownFetch(`https://us-central1-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent`);
outcome.trace = await ownFetch(`https://cloudtrace.googleapis.com/v2/projects/${PROJECT}/traces:batchWrite`);
outcome.jwks = await fetch("https://firebaseappcheck.googleapis.com/v1/jwks").then(() => "sent", codeOf);

// A firebase-admin service no row serves loads, unobserved.
outcome.messaging = await import("firebase-admin/messaging").then(() => "loaded", codeOf);

// Realtime Database: a named instance of the live project, and another project's.
const databaseOptions = { projectId: PROJECT, credential: callbackCredential, httpAgent: agent };
const ownInstance = initializeApp({ ...databaseOptions, databaseURL: `https://${PROJECT}-reports.firebaseio.com` }, "own-instance");
const otherInstance = initializeApp({ ...databaseOptions, databaseURL: "https://another-project-default-rtdb.firebaseio.com" }, "other-instance");
outcome.ownInstance = openDatabase(ownInstance);
outcome.otherInstance = openDatabase(otherInstance);

// An Admin app that names another project is still refused before any request.
const answeredBefore = answered.length;
const otherProject = initializeApp({ projectId: "another-project", credential: callbackCredential, httpAgent: agent }, "other-project");
outcome.otherProjectLookup = await lookup(otherProject);
outcome.otherProjectSent = answered.length - answeredBefore;

outcome.trapped = [...new Set(trapped)].sort();
outcome.health = await processHealth();
google.close();
console.log(`OUTCOME ${JSON.stringify(outcome)}`);
process.exit(0);
