/**
 * The Codex phase without its sandbox check, for the session runner's
 * tests, which enter it on the host. `runCodexSession` never names this
 * file unless a test passes it as `phaseScript`.
 */
import { readFileSync } from 'node:fs';
import { codexPhaseSchema, runCodexPhase } from '../codex-phase.ts';

const file = process.argv[2];
if (file === undefined) throw new Error('usage: bun codex-phase-on-host.ts <phase file>');
process.exit(await runCodexPhase(codexPhaseSchema.parse(JSON.parse(readFileSync(file, 'utf8')))));
