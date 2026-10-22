// Runs under Node, where the dev server and its server-rendered modules run:
// `node loopback-tls-node.mjs <dir>` with self-signed `<dir>/own.{key,pem}`
// and `<dir>/other.{key,pem}`, and `<dir>/ca.pem` with two leaves it issued
// for 127.0.0.1, `<dir>/leafA.{key,pem}` and `<dir>/leafB.{key,pem}`. Starts
// an HTTPS server per certificate and prints one JSON object naming what
// each dial did.
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { hostTrustFor, tlsOptionsFor, trustedFetch } from "../../../dist/remote/loopback-tls.js";

const dir = process.argv[2];
const credentials = (name) => ({
  key: readFileSync(join(dir, `${name}.key`), "utf8"),
  cert: readFileSync(join(dir, `${name}.pem`), "utf8"),
});
const own = credentials("own");
const other = credentials("other");
const ca = readFileSync(join(dir, "ca.pem"), "utf8");
const leafA = credentials("leafA");
const leafB = credentials("leafB");

function listen(creds) {
  const server = createServer(creds, (request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      response.setHeader("x-echo-method", request.method ?? "");
      response.end(JSON.stringify({ path: request.url, body, token: request.headers["x-token"] ?? null }));
    });
  });
  new WebSocketServer({ server }).on("connection", (socket) => socket.send("hello"));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ server, origin: `https://127.0.0.1:${server.address().port}` });
  }));
}

async function settle(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, message: `${error?.cause?.code ?? error?.code ?? ""} ${error?.message ?? error}` };
  }
}

function socketDial(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once("message", (data) => { socket.close(); resolve(String(data)); });
    socket.once("error", reject);
  });
}

const host = await listen(own);
const impostor = await listen(other);
// Another origin serving the same certificate: only the origin check keeps the trust off it.
const twin = await listen(own);
// A CA-issued leaf (mkcert style), and another leaf from the same CA: only the pin tells them apart.
const issued = await listen({ key: leafA.key, cert: leafA.cert + ca });
const sameCaImpostor = await listen({ key: leafB.key, cert: leafB.cert + ca });
const trust = hostTrustFor(host.origin, { cert: own.cert, key: own.key });
const impostorTrust = hostTrustFor(impostor.origin, { cert: own.cert, key: own.key });
const fetchHost = trustedFetch(trust);

const out = {};
out.fetch = await settle(async () => {
  const response = await fetchHost(`${host.origin}/upload?x=1`, { method: "PUT", headers: { "x-token": "t" }, body: new Blob(["bytes"]) });
  return { status: response.status, method: response.headers.get("x-echo-method"), body: await response.json() };
});
out.fetchImpostor = await settle(() => trustedFetch(impostorTrust)(`${impostor.origin}/`).then((r) => r.status));
out.fetchOtherOrigin = await settle(() => fetchHost(`${impostor.origin}/`).then((r) => r.status));
out.globalFetch = await settle(() => fetch(`${host.origin}/`).then((r) => r.status));
out.fetchTwinOrigin = await settle(() => fetchHost(`${twin.origin}/`).then((r) => r.status));
const issuedConfig = { cert: leafA.cert, ca };
const issuedTrust = hostTrustFor(issued.origin, issuedConfig);
const sameCaTrust = hostTrustFor(sameCaImpostor.origin, issuedConfig);
out.fetchIssued = await settle(() => trustedFetch(issuedTrust)(`${issued.origin}/`).then((r) => r.status));
out.socketIssued = await settle(() => socketDial(`${issued.origin.replace("https", "wss")}/`, tlsOptionsFor(issuedTrust)));
out.fetchSameCaImpostor = await settle(() => trustedFetch(sameCaTrust)(`${sameCaImpostor.origin}/`).then((r) => r.status));
out.socketSameCaImpostor = await settle(() => socketDial(`${sameCaImpostor.origin.replace("https", "wss")}/`, tlsOptionsFor(sameCaTrust)));
out.socket = await settle(() => socketDial(`${host.origin.replace("https", "wss")}/`, tlsOptionsFor(trust)));
out.socketImpostor = await settle(() => socketDial(`${impostor.origin.replace("https", "wss")}/`, tlsOptionsFor(impostorTrust)));
out.socketWithoutTrust = await settle(() => socketDial(`${host.origin.replace("https", "wss")}/`, {}));

console.log(JSON.stringify(out));
for (const { server } of [host, impostor, twin, issued, sameCaImpostor]) {
  server.closeAllConnections();
  server.close();
}
