// A server process started with `node --import @pyric/cli/register` and
// PYRIC_SANDBOX=local: the same
// Firebase AI Logic calls as the page, answered by the process's own sandbox.
// The first argument is the token server's URL, which its CustomProvider calls.
import { runAiChecks } from "./ai-checks.js";

console.log(`ai-checks ${JSON.stringify(await runAiChecks("server", process.argv[2]))}`);
