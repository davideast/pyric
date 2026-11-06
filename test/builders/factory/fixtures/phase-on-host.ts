/**
 * The agent phase without its sandbox check, for the session tests, which
 * enter it on the host. `runAgentSession` never names this file unless a
 * test passes it as `phaseScript`.
 */
import { readFileSync } from 'node:fs';
import { agentPhaseSchema, runAgentPhase } from '../agent-phase.ts';

const file = process.argv[2];
if (file === undefined) throw new Error('usage: bun phase-on-host.ts <phase file>');
// Use this process's stdout before the agent starts, as anything in the
// phase may: Bun then makes the pipe non-blocking, which the agent must not
// inherit (`agent-phase.test.ts`).
void process.stdout;
process.exit(await runAgentPhase(agentPhaseSchema.parse(JSON.parse(readFileSync(file, 'utf8')))));
