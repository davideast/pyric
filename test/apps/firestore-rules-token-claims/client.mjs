// `node --import @pyric/cli/register client.mjs` runs the same checks as the
// page, from a server process, and prints them on one line.
import { runChecks } from "./checks.js";

console.log(`checks ${JSON.stringify(await runChecks())}`);
process.exit(0);
