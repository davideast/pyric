/**
 * Probe execution: each probe runs in a fresh local world (Pyric sandbox,
 * the app's rules, seeded state), setup steps first, then the step under
 * test. A setup denial or an engine error makes the probe invalid, never a
 * finding.
 */
import { parseResourcePattern } from '../../sandbox/internal/index.js';
import { ProbeWorld, type WorldRules, type WorldState } from './world.js';
import type { Finding, Probe, ProbeActor, ProbeResult, StepResult } from './types.js';

/** Rules available to probes: one Firestore ruleset and any number of RTDB rulesets (instances, shards). */
export interface ProbeRules {
  firestore?: string;
  rtdb: unknown[];
}

/** How deep a path reaches into an RTDB rules tree (literal keys first, then a `$` wildcard). */
function coverDepth(rules: unknown, path: string): number {
  let node = (rules as { rules?: unknown } | null)?.rules as Record<string, unknown> | undefined;
  let depth = 0;
  for (const seg of path.split('/').filter(Boolean)) {
    if (!node || typeof node !== 'object') break;
    const direct = Object.hasOwn(node, seg) ? node[seg] : undefined;
    const next = direct ?? Object.entries(node).find(([k]) => k.startsWith('$'))?.[1];
    if (!next || typeof next !== 'object') break;
    node = next as Record<string, unknown>;
    depth++;
  }
  return depth;
}

/** The RTDB ruleset that governs a path: the one whose tree reaches deepest. */
export function rtdbRulesFor(rules: ProbeRules, path: string): unknown | undefined {
  let best: unknown;
  let bestDepth = -1;
  for (const r of rules.rtdb) {
    const d = coverDepth(r, path);
    if (d > bestDepth) {
      best = r;
      bestDepth = d;
    }
  }
  return best;
}

function sampleProbePath(probe: Probe): string {
  return parseResourcePattern(probe.service, probe.template)
    .segments.map((s) => {
      if (s.kind === 'lit') return s.text;
      if (s.kind === 'var') return `${s.prefix ?? ''}x${s.suffix ?? ''}`;
      return 'x';
    })
    .join('/');
}

function worldRules(probe: Probe, rules: ProbeRules): WorldRules | undefined {
  if (probe.service === 'firestore') return rules.firestore ? { firestore: rules.firestore } : undefined;
  const concrete = probe.attack.path || Object.keys((probe.attack.data as object) ?? {})[0] || '';
  const rtdb = rtdbRulesFor(rules, concrete || sampleProbePath(probe));
  return rtdb ? { rtdb } : undefined;
}

export async function runProbe(probe: Probe, rules: ProbeRules, actors: ProbeActor[], state: WorldState = {}): Promise<ProbeResult | undefined> {
  const wr = worldRules(probe, rules);
  if (!wr) return undefined;
  const steps: StepResult[] = [];
  let world: ProbeWorld;
  try {
    world = new ProbeWorld(wr, actors, state);
  } catch (e) {
    return { probe, outcome: 'invalid', reason: `engine error: ${e instanceof Error ? e.message : String(e)}`, steps };
  }
  try {
    for (const step of probe.seed) {
      const r = await world.run(step);
      steps.push(r);
      if (r.decision === 'error') return { probe, outcome: 'invalid', reason: `seed failed: ${r.message}`, steps };
    }
    for (const step of probe.setup) {
      const r = await world.run(step);
      steps.push(r);
      if (r.decision !== 'allow') return { probe, outcome: 'invalid', reason: `setup ${step.actor} ${step.method} ${step.path} was ${r.decision === 'deny' ? 'denied' : `an error: ${r.message}`}`, steps };
    }
    const r = await world.run(probe.attack);
    steps.push(r);
    if (r.decision === 'error') return { probe, outcome: 'invalid', reason: `engine error: ${r.message}`, steps };
    if (probe.expect === 'deny') return { probe, outcome: r.decision === 'allow' ? 'hit' : 'clean', steps };
    if (r.decision === 'allow') return { probe, outcome: 'clean', steps };
    if (probe.inconclusiveOnDeny) return { probe, outcome: 'invalid', reason: probe.inconclusiveOnDeny, steps };
    return { probe, outcome: 'hit', steps };
  } finally {
    world.dispose();
  }
}

/** A finding for a hit. */
export function findingFor(result: ProbeResult, actors: ProbeActor[]): Finding {
  const p = result.probe;
  const attacker = actors.find((a) => a.role === p.attack.actor);
  const f: Finding = {
    path: p.template,
    op: p.op,
    kind: p.kind,
    status: p.status,
    evidence: p.evidence,
    service: p.service,
    probeId: p.id,
    operation: p.attack,
    sources: p.sources,
  };
  if (attacker) f.actorUid = attacker.uid;
  return f;
}
