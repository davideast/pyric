// A server set up the way firebase-admin's docs show: the app options name no
// project, and the credential is a service account file. firebase-admin reads
// the project from the service account's project_id. This file is a
// placeholder with no real key; under @pyric/cli/register, cert() keeps only
// its project id.
import { cert, initializeApp } from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";

const token = process.argv[2];
if (!token) throw new Error("usage: node admin-server.mjs <app-check-token>");

const credential = cert("./service-account.json");
const app = initializeApp({ credential });
try {
  const verified = await getAppCheck().verifyToken(token);
  const result = {
    ok: true,
    appId: verified.appId,
    aud: verified.token.aud,
    sameCredential: app.options.credential === credential,
    hasProjectId: "projectId" in app.options,
    options: app.options,
  };
  console.log(`verify ${JSON.stringify(result)}`);
} catch (error) {
  console.log(`verify ${JSON.stringify({ ok: false, code: error.code, message: error.message })}`);
}
process.exit(0);
