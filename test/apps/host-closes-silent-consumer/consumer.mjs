// A long-lived server process on the Node host. It marks itself online,
// registers an onDisconnect that marks it offline, and listens to
// `messages/latest`, logging each value. The onDisconnect goes over the remote
// handle's raw relay channel: it is the same `worker-op` the Kotlin, Swift and
// Flutter clients send (`pyric-admin` has no onDisconnect).
import { remoteSandbox } from "@pyric/cli/remote";

const [name, url] = process.argv.slice(2);
if (!name || !url) throw new Error("usage: node consumer.mjs <name> <host url>");

const sandbox = remoteSandbox({ url });
const status = `status/${name}`;
await sandbox.rtdb.set(status, "online");
await sandbox.channel.op({ method: "rtdb.onDisconnectSet", path: status, value: "offline" });
sandbox.rtdb.onValue(
  "messages/latest",
  (snapshot) => console.log(`${name} heard ${JSON.stringify(snapshot.value)}`),
  (error) => console.log(`${name} listener ended: ${error.code} ${error.message}`),
);
console.log(`${name} online`);
