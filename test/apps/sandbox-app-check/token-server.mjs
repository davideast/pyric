// The backend a CustomProvider calls: a server started with
// `node --import @pyric/cli/register`, which mints App Check tokens with
// firebase-admin's createToken, as an app's attestation backend does.
// GET /app-check-token answers { token, expireTimeMillis }.
import { createServer } from "node:http";
import { initializeApp } from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";

const APP_ID = "1:123456789012:web:abcdef0123456789";
const port = Number(process.env.TOKEN_PORT);

initializeApp({ projectId: "my-real-project" });

const server = createServer(async (request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  if (request.url !== "/app-check-token") {
    response.writeHead(404).end();
    return;
  }
  const { token, ttlMillis } = await getAppCheck().createToken(APP_ID);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ token, expireTimeMillis: Date.now() + ttlMillis }));
});

server.listen(port, "127.0.0.1", () => console.log(`token-server listening on ${port}`));
