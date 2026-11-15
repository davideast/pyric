import { runChecks } from "./checks.js";

const email = process.argv[2] ?? "node@example.com";
const nextEmail = process.argv[3] ?? "node-next@example.com";

console.log(`checks ${JSON.stringify(await runChecks(email, nextEmail))}`);
process.exit(0);
