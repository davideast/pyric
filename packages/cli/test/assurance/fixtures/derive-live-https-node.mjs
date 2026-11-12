import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { cloneLoopbackSandboxHttp } from "../../../dist/assurance/derive-live-http.js";
import { hostTrustFor } from "../../../dist/remote/loopback-tls.js";

const dir = process.argv[2];
const credentials = (name) => ({
  key: readFileSync(join(dir, `${name}.key`), "utf8"),
  cert: readFileSync(join(dir, `${name}.pem`), "utf8"),
});
const own = credentials("own");
const impostor = credentials("impostor");
const REQUIRED_TOKEN = "tok-https-pin";

function startHttpsSandboxServer(creds) {
  const server = createServer(creds, (req, res) => {
    if (req.headers["x-pyric-session-token"] !== REQUIRED_TOKEN) {
      res.statusCode = 401;
      res.end("missing or invalid session token");
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/__pyric/init.json") {
      res.end(
        JSON.stringify({
          rules: "rules_version = '2'; service cloud.firestore {}",
          instanceId: "inst-https",
        }),
      );
      return;
    }
    if (req.url === "/__pyric/state") {
      res.end(
        JSON.stringify({
          version: 1,
          firestore: null,
          auth: {
            users: [{ uid: "u-https", email: "https@example.test" }],
            providers: {},
          },
          storage: [],
        }),
      );
      return;
    }
    res.end(JSON.stringify({ ok: true, data: { events: [] } }));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, origin: `https://127.0.0.1:${port}` });
    }),
  );
}

const host = await startHttpsSandboxServer(own);
const impostorHost = await startHttpsSandboxServer(impostor);

const ownTrust = hostTrustFor(host.origin, { cert: own.cert, key: own.key });
const mismatchedTrust = hostTrustFor(impostorHost.origin, {
  cert: own.cert,
  key: own.key,
});

const ownProjDir = join(dir, "proj-own");
mkdirSync(join(ownProjDir, ".pyric"), { recursive: true });
writeFileSync(join(ownProjDir, "firebase.json"), "{}");
writeFileSync(
  join(ownProjDir, ".pyric", "serve.json"),
  JSON.stringify({
    pid: process.pid,
    port: host.port,
    url: host.origin,
    token: REQUIRED_TOKEN,
    tls: {
      ca: ownTrust.ca,
      fingerprint256: ownTrust.fingerprint256,
    },
  }),
);

const impostorProjDir = join(dir, "proj-impostor");
mkdirSync(join(impostorProjDir, ".pyric"), { recursive: true });
writeFileSync(join(impostorProjDir, "firebase.json"), "{}");
writeFileSync(
  join(impostorProjDir, ".pyric", "serve.json"),
  JSON.stringify({
    pid: process.pid,
    port: impostorHost.port,
    url: impostorHost.origin,
    token: REQUIRED_TOKEN,
    tls: {
      ca: mismatchedTrust.ca,
      fingerprint256: mismatchedTrust.fingerprint256,
    },
  }),
);

async function settle(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, message: String(err?.message ?? err) };
  }
}

const prevCwd = process.cwd();
let ownClone;
let impostorClone;
try {
  process.chdir(ownProjDir);
  // Intentionally omit options.projectDir to verify cwd fallback + HTTPS cert pinning together.
  ownClone = await settle(async () => {
    const cloned = await cloneLoopbackSandboxHttp(host.origin);
    return {
      origin: cloned.origin,
      users: cloned.snapshot.auth.users.map((u) => u.uid),
    };
  });

  impostorClone = await settle(async () => {
    await cloneLoopbackSandboxHttp(impostorHost.origin, {
      projectDir: impostorProjDir,
    });
    return true;
  });
} finally {
  process.chdir(prevCwd);
  for (const { server } of [host, impostorHost]) {
    server.closeAllConnections();
    server.close();
  }
}

console.log(JSON.stringify({ ownClone, impostorClone }));
