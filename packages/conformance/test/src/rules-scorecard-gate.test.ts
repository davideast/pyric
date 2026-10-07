import { describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_SCRIPT = join(HERE, '../../src/rules-scorecard-gate.ts');
// The gate replays every scenario of three engines in a child process. It takes
// about 2.5 s on a laptop and longer on a loaded CI runner, past bun's 5 s
// default per test.
const GATE_TIMEOUT_MS = 60_000;

describe('Unified rules scorecard gate CLI reporter', () => {
  it('reports all three scorecards side by side with breakdown tip on standard execution', () => {
    const out = execSync(`bun run "${GATE_SCRIPT}"`, { encoding: 'utf8', stdio: 'pipe' });
    expect(out).toContain('Firestore Rules conformance:');
    expect(out).toContain('Storage Rules conformance:');
    expect(out).toContain('RTDB Rules conformance:');
    expect(out).toContain('Tip: Pass --breakdown');
  }, GATE_TIMEOUT_MS);

  it('prints detailed per-engine construct breakdowns when --breakdown is supplied', () => {
    const out = execSync(`bun run "${GATE_SCRIPT}" --breakdown`, { encoding: 'utf8', stdio: 'pipe' });
    expect(out).toContain('--- Firestore Rules Breakdown ---');
    expect(out).toContain('--- Storage Rules Breakdown ---');
    expect(out).not.toContain('acceptance-mismatch] firestore.function.debug');
    expect(out).toContain('[unprobeable] firestore.semantic.get-budget');
    expect(out).toContain('[diverged] storage.function.firestore.get');
    expect(out).toContain('--- RTDB Rules Breakdown ---');
    expect(out).not.toContain('[diverged] rtdb.operator.add');
    expect(out).toContain('[diverged] rtdb.binding.query.orderByKey (diverged by: rtdb-rules#26)');
    expect(out).toContain('[diverged] rtdb.binding.query.orderByPriority (diverged by: rtdb-rules#26)');
  }, GATE_TIMEOUT_MS);
});
