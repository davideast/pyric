// The app's backend, as in #1552: it verifies the X-Firebase-AppCheck token the
// page sent with firebase-admin's getAppCheck().verifyToken and answers 401
// when that fails. Run under `node --import @pyric/cli/register`.
//
// It takes the page's token and runs each verification the scenario asserts in
// one process, so firebase-admin's key cache carries from one to the next.
// After each one it notes what the JWKS stand-in saw (jwks-stand-in.mjs), and
// at the end whether the real firebase-admin is in the module graph.
import { registerHooks } from "node:module";

const loaded = [];
registerHooks({
  load(url, context, nextLoad) {
    loaded.push(url);
    return nextLoad(url, context);
  },
});

const { initializeApp } = await import("firebase-admin/app");
const { getAppCheck } = await import("firebase-admin/app-check");

const APP_ID = "1:123456789012:web:abcdef0123456789";
const pageToken = process.argv[2];
if (!pageToken) throw new Error("usage: node verify.mjs <app-check-token>");

const standIn = globalThis[Symbol.for("pyric.scenario.jwksStandIn")] ?? { served: [], refused: [] };
initializeApp({ projectId: "my-real-project" });

/** One signature character changed, mid-signature so no padding bit absorbs it. */
function tampered(token) {
  const [header, payload, signature] = token.split(".");
  const at = Math.floor(signature.length / 2);
  const swapped = signature[at] === "A" ? "B" : "A";
  return `${header}.${payload}.${signature.slice(0, at)}${swapped}${signature.slice(at + 1)}`;
}

async function verify(label, token, options) {
  const servedBefore = standIn.served.length;
  let outcome;
  try {
    const result = await getAppCheck().verifyToken(token, options);
    outcome = {
      ok: true,
      appId: result.appId,
      claims: Object.keys(result.token).sort(),
      appIdClaim: result.token.app_id,
      alreadyConsumed: result.alreadyConsumed ?? null,
    };
  } catch (error) {
    outcome = { ok: false, code: error.code, message: error.message };
  }
  return { label, ...outcome, jwksRequests: standIn.served.length - servedBefore };
}

const steps = process.env.VERIFY_STEPS === "sandbox-ai-mode" ? ["firebase"] : ["firebase", "again", "tampered", "consume", "sandbox"];
const results = [];
if (steps.includes("firebase")) results.push(await verify("firebase", pageToken));
if (steps.includes("again")) results.push(await verify("again", pageToken));
if (steps.includes("tampered")) results.push(await verify("tampered", tampered(pageToken)));
if (steps.includes("consume")) {
  results.push(await verify("consume-1", pageToken, { consume: true }));
  results.push(await verify("consume-2", pageToken, { consume: true }));
}
if (steps.includes("sandbox")) {
  const { token } = await getAppCheck().createToken(APP_ID);
  results.push(await verify("sandbox", token));
  results.push(await verify("sandbox-tampered", tampered(token)));
}

const realAdminLoaded = loaded.some((url) => /\/node_modules\/firebase-admin\//.test(url));
console.log(`verify ${JSON.stringify({ results, served: standIn.served, refused: standIn.refused, realAdminLoaded })}`);
process.exit(0);
