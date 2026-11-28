// Shared scoring harnesses for Storage, RTDB, Firestore, and standalone policy probes.
import assert from 'node:assert/strict';
import { buildRtdbCase, buildStorageCase, defineProbeFixtures, sha256 } from './fixture.mjs';
import { createRulesRuntime, tryCompile } from './runtime.mjs';

export function assertProbeOutput(output, caseIds) {
  assert.ok(output && typeof output === 'object', 'probe output must be an object');
  const expected = [...caseIds].sort();
  for (const side of ['candidate', 'mutant']) {
    assert.ok(output[side] && typeof output[side] === 'object', 'missing ' + side + ' outcomes');
    assert.deepEqual(
      Object.keys(output[side]).sort(),
      expected,
      side + ' case keys do not match declared cases',
    );
  }
  return output;
}

export function emitProbeOutput(output, caseIds) {
  if (caseIds) assertProbeOutput(output, caseIds);
  console.log(JSON.stringify(output));
}

function resolveRulesSource(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) + '\n';
}

export async function scoreStorageProbe(spec) {
  const fixtures = defineProbeFixtures(spec.cases);
  const runtime = spec.runtime ?? createRulesRuntime(spec.runtimeOptions);
  const compiled = await tryCompile(async () => {
    const candidateSource = spec.compileCandidate
      ? await spec.compileCandidate(runtime)
      : spec.candidateRules;
    assert.ok(typeof candidateSource === 'string' && candidateSource.length > 0, 'missing candidate Storage rules');
    const mutantSource = spec.compileMutant
      ? await spec.compileMutant(runtime, candidateSource)
      : spec.mutantRules ?? candidateSource;
    return { candidateSource, mutantSource };
  }, fixtures.ids);
  if (!compiled.ok) return compiled.result;

  const { candidateSource, mutantSource } = compiled.value;
  const bucket = spec.bucket ?? 'offline-probe-bucket';
  const useRaw = Boolean(spec.useRawEvaluator);

  async function runVariant(rulesSource, transformCase) {
    if (useRaw) {
      const { parseStorageRules, evaluateStorageRules } = await runtime.storageInternal();
      const parsed = parseStorageRules(rulesSource);
      const objects = new Map(Object.entries(spec.seedObjects ?? {}).map(([k, v]) => [k, structuredClone(v)]));
      const outcomes = {};
      for (const rawCase of fixtures.list) {
        const c = transformCase ? transformCase(structuredClone(rawCase)) : rawCase;
        const stored = spec.stateful
          ? (objects.get(c.path) ?? null)
          : (c.resource ?? null);
        const request = {
          path: 'b/' + (c.bucket ?? bucket) + '/o/' + c.path,
          auth: c.auth ?? null,
          method: c.method ?? 'write',
          ...(c.requestResource !== undefined ? { resource: c.requestResource } : {}),
        };
        const result = evaluateStorageRules(parsed, { request, resource: stored });
        assert.ok(!result.resourceLimit, 'unexpected Storage resource limit for ' + c.id);
        outcomes[c.id] = result.allowed ? 'ALLOW' : 'DENY';
        if (spec.stateful && result.allowed) {
          if (c.method === 'delete') objects.delete(c.path);
          else if (c.requestResource !== undefined) objects.set(c.path, structuredClone(c.requestResource));
        }
      }
      return outcomes;
    }

    const { storageRules } = await runtime.rules();
    const ruleset = storageRules(rulesSource, { bucket });
    const objects = new Map(Object.entries(spec.seedObjects ?? {}).map(([k, v]) => [k, structuredClone(v)]));
    const outcomes = {};
    for (const rawCase of fixtures.list) {
      const c = transformCase ? transformCase(structuredClone(rawCase)) : rawCase;
      const stored = spec.stateful
        ? (objects.get(c.path) ?? null)
        : c.resource;
      const built = buildStorageCase({ ...c, resource: stored });
      const [row] = ruleset.simulate([built]).cases;
      assert.ok(row && !row.unsupported && !row.resourceLimit, 'Storage case failed: ' + c.id + ': ' + (row?.reasons?.join('; ') ?? 'no row'));
      outcomes[c.id] = row.decision;
      if (spec.stateful && row.decision === 'ALLOW') {
        if (c.method === 'delete') objects.delete(c.path);
        else if (c.requestResource !== undefined) objects.set(c.path, structuredClone(c.requestResource));
      }
    }
    return outcomes;
  }

  const candidate = await runVariant(candidateSource);
  const mutant = await runVariant(mutantSource, spec.mutateCase);
  return assertProbeOutput({
    candidate,
    mutant,
    artifacts: { rulesSha256: sha256(candidateSource), ...(spec.artifacts ?? {}) },
  }, fixtures.ids);
}

export async function scoreRtdbProbe(spec) {
  const fixtures = defineProbeFixtures(spec.cases);
  const runtime = spec.runtime ?? createRulesRuntime(spec.runtimeOptions);
  const compiled = await tryCompile(async () => {
    const candidateRules = spec.compileCandidate
      ? await spec.compileCandidate(runtime)
      : spec.candidateRules;
    assert.ok(candidateRules !== undefined, 'missing candidate RTDB rules');
    const mutantRules = spec.compileMutant
      ? await spec.compileMutant(runtime, candidateRules)
      : spec.mutantRules ?? candidateRules;
    return { candidateRules, mutantRules };
  }, fixtures.ids);
  if (!compiled.ok) return compiled.result;

  const { rtdbRules } = await runtime.rules();
  const { candidateRules, mutantRules } = compiled.value;

  function runVariant(rulesInput, transformCase) {
    const handle = rtdbRules(rulesInput);
    const outcomes = {};
    for (const rawCase of fixtures.list) {
      const c = transformCase ? transformCase(structuredClone(rawCase)) : rawCase;
      const built = buildRtdbCase(c);
      const [row] = handle.simulate([built]).cases;
      assert.ok(row && !row.unsupported, 'RTDB case unsupported: ' + c.id + ': ' + (row?.reason ?? 'no row'));
      outcomes[c.id] = row.decision;
    }
    return outcomes;
  }

  const candidate = runVariant(candidateRules);
  const mutant = runVariant(mutantRules, spec.mutateCase);
  return assertProbeOutput({
    candidate,
    mutant,
    artifacts: { rulesSha256: sha256(resolveRulesSource(candidateRules)), ...(spec.artifacts ?? {}) },
  }, fixtures.ids);
}

export async function scoreFirestoreProbe(spec) {
  const fixtures = defineProbeFixtures(spec.cases);
  const runtime = spec.runtime ?? createRulesRuntime(spec.runtimeOptions);
  const compiled = await tryCompile(async () => {
    const candidateSource = spec.compileCandidate
      ? await spec.compileCandidate(runtime)
      : spec.candidateRules;
    assert.ok(typeof candidateSource === 'string' && candidateSource.length > 0, 'missing candidate Firestore rules');
    const mutantSource = spec.compileMutant
      ? await spec.compileMutant(runtime, candidateSource)
      : spec.mutantRules ?? candidateSource;
    return { candidateSource, mutantSource };
  }, fixtures.ids);
  if (!compiled.ok) return compiled.result;

  const { firestoreRules } = await runtime.rules();
  const { candidateSource, mutantSource } = compiled.value;

  function runVariant(rulesSource, transformCase) {
    const handle = firestoreRules(rulesSource);
    const outcomes = {};
    for (const rawCase of fixtures.list) {
      const c = transformCase ? transformCase(structuredClone(rawCase)) : rawCase;
      const { id, ...caseInput } = c;
      const [row] = handle.simulate([{ description: id, expectation: 'ALLOW', ...caseInput }]).cases;
      assert.ok(row && !row.unsupported && !row.resourceLimit, 'Firestore case failed: ' + id + ': ' + (row?.reasons?.join('; ') ?? 'no row'));
      outcomes[id] = row.decision;
    }
    return outcomes;
  }

  const candidate = runVariant(candidateSource);
  const mutant = runVariant(mutantSource, spec.mutateCase);
  return assertProbeOutput({
    candidate,
    mutant,
    artifacts: { rulesSha256: sha256(candidateSource), ...(spec.artifacts ?? {}) },
  }, fixtures.ids);
}

export async function scoreStandaloneProbe(spec) {
  const fixtures = defineProbeFixtures(spec.cases);
  const runtime = spec.runtime ?? createRulesRuntime(spec.runtimeOptions);
  const compiled = await tryCompile(async () => {
    const candidateCompiled = await spec.compileCandidate(runtime);
    const mutantCompiled = spec.compileMutant
      ? await spec.compileMutant(runtime, candidateCompiled)
      : candidateCompiled;
    return { candidateCompiled, mutantCompiled };
  }, fixtures.ids);
  if (!compiled.ok) return compiled.result;

  const { candidateCompiled, mutantCompiled } = compiled.value;
  const candidate = {};
  const mutant = {};
  for (const rawCase of fixtures.list) {
    candidate[rawCase.id] = await spec.evaluate(candidateCompiled, structuredClone(rawCase), 'candidate');
    const mutantCase = spec.mutateCase ? spec.mutateCase(structuredClone(rawCase)) : structuredClone(rawCase);
    mutant[rawCase.id] = await spec.evaluate(mutantCompiled, mutantCase, 'mutant');
  }
  const output = { candidate, mutant };
  if (spec.artifacts) output.artifacts = spec.artifacts;
  return assertProbeOutput(output, fixtures.ids);
}
