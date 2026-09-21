import { runCli } from '../../shared/observability/cli.mjs';
import manifest from './observability.json' with { type: 'json' };
try { process.exitCode = await runCli(process.argv.slice(2), manifest); }
catch (error) { console.error(error.message); process.exitCode = 2; }
