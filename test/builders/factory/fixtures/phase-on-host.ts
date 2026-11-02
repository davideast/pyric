/**
 * The agent phase without its sandbox check, for the session tests, which
 * enter it on the host. `runAgentSession` never names this file unless a
 * test passes it as `phaseScript`.
 */
import { readFileSync } from 'node:fs';
import { agentPhaseSchema, runAgentPhase } from '../agent-phase.ts';

const file = process.argv[2];
if (file === undefined) throw new Error('usage: bun phase-on-host.ts <phase file>');
process.exit(await runAgentPhase(agentPhaseSchema.parse(JSON.parse(readFileSync(file, 'utf8')))));
