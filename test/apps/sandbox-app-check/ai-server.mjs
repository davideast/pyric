// A server process started with `node --import @pyric/cli/register` and
// PYRIC_SANDBOX=local: the same Firebase AI Logic calls as the page, answered
// by the process's own sandbox. A Node process has no `document`, so the
// reCAPTCHA providers throw as the Firebase SDK's do, and the process attests
// with a CustomProvider that calls the token server at the first argument.
import { runAiChecks, runRecaptchaChecks, tokenServerProvider } from "./ai-checks.js";

const tokenUrl = process.argv[2];
console.log(`recaptcha-checks ${JSON.stringify(runRecaptchaChecks("server"))}`);
console.log(`ai-checks ${JSON.stringify(await runAiChecks("server", tokenUrl, tokenServerProvider(tokenUrl)))}`);
