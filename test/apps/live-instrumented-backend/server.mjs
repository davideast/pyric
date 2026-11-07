// The orders API's backend: a Node server that loads request instrumentation
// first, then uses firebase-admin with the app's own credentials, as #2445's
// report runs it under `node --import @pyric/live/register`.
//
// Every request the Admin SDK makes with its Agent keeps its Google host but
// connects to a local stand-in for Google, so the guard still judges each
// request by its Google host. The service-account token exchange ignores the
// Agent, so it reaches the scenario's trap (`trap.mjs`) instead, which fails
// its host lookup and records the host: the run reaches no real host. The
// job prints what each call got on its OUTCOME line.
import { trapped } from "./trap.mjs";
import { instrumented } from "./instrument.mjs";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import https from "node:https";
import net from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

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
    const isToken = path.endsWith("/token");
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

/** The backend's own https.request to the token endpoint, through the same instrumentation and Agent. */
function ownTokenRequest() {
  return new Promise((resolve) => {
    const request = https.request({ host: "oauth2.googleapis.com", path: "/token", method: "POST", agent }, (response) => {
      response.resume();
      resolve("sent");
    });
    request.on("error", (error) => resolve(codeOf(error)));
    request.end("grant_type=refresh_token");
  });
}

const outcome = {};
const adcApp = initializeApp({ projectId: PROJECT, credential: applicationDefault(agent), httpAgent: agent }, "adc");
const certApp = initializeApp({ projectId: PROJECT, credential: cert(serviceAccount, agent), httpAgent: agent }, "cert");
outcome.adcLookup = await lookup(adcApp);
// The exchange fails at the trap, so the lookup does too; what counts is that the guard let it out.
await lookup(certApp);
outcome.tokenExchanges = answered.filter((path) => path.endsWith("/token")).length;
outcome.trapped = [...new Set(trapped)];
outcome.instrumented = instrumented.requests > 0;
outcome.ownTokenRequest = await ownTokenRequest();
google.close();
console.log(`OUTCOME ${JSON.stringify(outcome)}`);
process.exit(0);
