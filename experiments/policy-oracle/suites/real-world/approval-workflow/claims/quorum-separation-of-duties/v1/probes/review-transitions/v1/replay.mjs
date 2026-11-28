import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const shared = await import(
  pathToFileURL(join(process.env.ORACLE_ROOT, 'adapters/_shared/v1/index.mjs')).href
);
const here = dirname(fileURLToPath(import.meta.url));
const policySource = shared.readText(join(here, 'policy.rules'));
const mutantSource = shared.readText(join(here, 'mutant.rules'));
const cases = shared.readJson(join(here, 'cases.json'));

const output = await shared.scoreStandaloneProbe({
  cases,
  compileCandidate: async (runtime) => {
    const mod = await runtime.policy();
    const policy = mod.compilePolicy(policySource);
    const standalone = typeof policy.standaloneModule === 'function'
      && typeof mod.instantiateStandaloneModule === 'function'
      ? mod.instantiateStandaloneModule(policy.standaloneModule().moduleSource)
      : null;
    return { policy, standalone };
  },
  compileMutant: async (runtime) => {
    const { compilePolicy } = await runtime.policy();
    return { policy: compilePolicy(mutantSource), standalone: null };
  },
  evaluate: (compiled, entry) => {
    const verdict = compiled.policy.judge(entry.transition);
    if (compiled.standalone) {
      const stand = compiled.standalone.judge(entry.transition);
      if (Boolean(stand.ok) !== Boolean(verdict.ok)) {
        throw new Error('Standalone parity mismatch on ' + entry.id);
      }
    }
    return verdict.ok ? 'ALLOW' : 'DENY';
  },
  artifacts: { policySha256: shared.sha256(policySource) },
});

shared.emitProbeOutput(output, cases.map((c) => c.id));
