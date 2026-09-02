import { describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_SCRIPT = join(HERE, '../../src/rules-scorecard-gate.ts');

describe('Unified rules scorecard gate CLI reporter', () => {
  it('reports all three scorecards side by side with breakdown tip on standard execution', () => {
    const out = execSync(`bun run "${GATE_SCRIPT}"`, { encoding: 'utf8', stdio: 'pipe' });
    expect(out).toContain('Firestore Rules conformance:');
    expect(out).toContain('Storage Rules conformance:');
    expect(out).toContain('RTDB Rules conformance:');
    expect(out).toContain('Tip: Pass --breakdown');
  });

  it('prints detailed per-engine construct breakdowns when --breakdown is supplied', () => {
    const out = execSync(`bun run "${GATE_SCRIPT}" --breakdown`, { encoding: 'utf8', stdio: 'pipe' });
    expect(out).toContain('--- Firestore Rules Breakdown ---');
    expect(out).toContain('--- Storage Rules Breakdown ---');
    expect(out).toContain('--- RTDB Rules Breakdown ---');
    // The linter and evaluator now reject debug() the way production does,
    // so the construct is conformant and no longer an acceptance mismatch.
    // Firestore's breakdown lists only its three unprobeable constructs.
    expect(out).not.toContain('acceptance-mismatch] firestore.function.debug');
    expect(out).toContain('[unprobeable] firestore.semantic.get-budget');
    expect(out).toContain('[diverged] storage.function.firestore.get');
    expect(out).toContain('All constructs conform cleanly.'); // RTDB is at 100%
  });
});
