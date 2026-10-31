import { remoteSandbox } from "@pyric/cli/remote";

// Registers an onDisconnect the way the Firebase presence sample does, with no
// rejection handler, and closes the handle in the same turn, so the host's
// reply cannot have arrived. The onDisconnect goes over the remote handle's raw
// relay channel, as the Kotlin, Swift and Flutter clients send it
// (`pyric-admin` has no onDisconnect). Exits on its own, without process.exit:
// an unhandled rejection ends Node with code 1.
const [url] = process.argv.slice(2);
if (!url) throw new Error("usage: node close-with-ondisconnect.mjs <host url>");

const sandbox = remoteSandbox({ url });
console.log(`attached, status reads ${JSON.stringify(await sandbox.rtdb.get("status"))}`);
void sandbox.channel.op({ method: "rtdb.onDisconnectSet", path: "presence/script", value: "offline" });
sandbox.close();
console.log("closed with an onDisconnect unanswered");
process.on("exit", (code) => console.log(`exiting with code ${code}`));
