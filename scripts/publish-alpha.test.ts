import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pinPyricPackages, tarballsIn } from '../test/apps/install.ts';
import {
  accessJson, advanceMainPastHistoricalPin, ALL_READ_WRITE, FIVE_EXISTING, NPM_PACK_STUB,
  PUBLISHED_NAMES, publishForReal, REAL_NODE, realStampRepo, REPO_ROOT, runPack, runPublish,
  setupPrepareReleaseRepo, staleOutDir, stampAndPublishDetached, TempDirTracker,
} from './lib/publish-test-harness.ts';
import { listTests } from './ci/test-shard.ts';
import { checkRulesTarball, ISOLATED_RULES_FILES, isNodeBuiltinSpecifier, planRulesProofJobs, verifyBrowserBundlesHaveNoNodeBuiltins } from './lib/rules-release-gate.ts';

const root = REPO_ROOT;
const tracker = new TempDirTracker();
afterEach(() => {
  tracker.cleanup();
});

const PACK = 'bash scripts/pack-packages.sh';
const PACKAGING_GATE = 'bash scripts/packaging-test.sh --packages dist/packages';
const UPLOADED = 'pyric pyric-admin create-pyric pyric-cli pyric-ui pyric-live';
const STAMP_WRITE = `node ${join(root, 'scripts/lib/proven-stamp.mjs')} write ${join(root, 'dist/packages')} 0.1.0-alpha.9 ${root} ${UPLOADED}`;
const STAMP_VERIFY = `node ${join(root, 'scripts/lib/proven-stamp.mjs')} verify ${join(root, 'dist/packages')} 0.1.0-alpha.9 ${root} ${UPLOADED}`;
const PACKED_UPLOADS = ['pyric', 'pyric-admin', 'create-pyric', 'pyric-cli', 'pyric-ui', 'pyric-live'].map(
  (name) => `uploaded ${name}-0.1.0-alpha.9.tgz packed ${name}`,
);

describe('alpha publish safety contract', () => {
  test('proves the tree before the first irreversible publish', () => {
    const { result, commands } = runPublish(tracker);
    expect(result.status).toBe(0);
    const tests = commands.indexOf('bun run test');
    const pack = commands.indexOf(PACK);
    const packaging = commands.indexOf(PACKAGING_GATE);
    const publish = commands.findIndex((command) => command.startsWith('npm publish '));
    expect(tests).toBeGreaterThanOrEqual(0);
    expect(tests).toBeLessThan(pack);
    expect(pack).toBeLessThan(packaging);
    expect(packaging).toBeLessThan(publish);
  });

  test('packs once, checks packed @pyric/rules drift, and runs the packaging gate on those tarballs', () => {
    const { result, commands } = runPublish(tracker);
    expect(result.status).toBe(0);
    expect(commands.filter((command) => command.startsWith(PACK))).toEqual([PACK]);
    expect(commands).not.toContain('bun run test:packaging');
    expect(commands.filter((command) => command.startsWith('bash scripts/packaging-test.sh'))).toEqual([PACKAGING_GATE]);
    const pack = commands.indexOf(PACK);
    const packedDrift = commands.findIndex((command) => command.includes('check-publish-version.mjs --packed'));
    expect(packedDrift).toBeGreaterThan(pack);
    const rebuildsOrRepacks = commands.slice(pack + 1).filter(
      (command) =>
        command.startsWith('bash scripts/build.sh') ||
        command.startsWith('npm pack') ||
        command === 'bun run build',
    );
    expect(rebuildsOrRepacks).toEqual([]);
  });

  test('every publish uploads a copy of a tarball the pack wrote, from the directory the last check verified', () => {
    const { result, commands } = runPublish(tracker);
    expect(result.status).toBe(0);
    const uploads = commands.filter((command) => command.startsWith('npm publish ')).map((command) => command.split(' ')[2] ?? '');
    const names = ['pyric', 'pyric-admin', 'create-pyric', 'pyric-cli', 'pyric-ui', 'pyric-live'].map((name) => `${name}-0.1.0-alpha.9.tgz`);
    expect(uploads.map((upload) => upload.split('/').pop())).toEqual(names);
    const uploadDir = uploads[0]?.slice(0, uploads[0].lastIndexOf('/')) ?? '';
    expect(uploadDir).not.toBe(join(root, 'dist/packages'));
    expect(uploads.every((upload) => upload.startsWith(`${uploadDir}/`))).toBe(true);
    const lastVerify = commands.filter((command) => command.includes('proven-stamp.mjs verify')).pop();
    expect(lastVerify).toContain(`verify ${uploadDir} 0.1.0-alpha.9`);
  });

  test('a failed packaging gate, app scenario, or proof prevents every publish', () => {
    expect(runPublish(tracker, { failCommand: PACKAGING_GATE }).commands.some((c) => c.startsWith('npm publish '))).toBe(false);
    expect(runPublish(tracker, { failBunCommand: 'test/apps/run.ts --packages dist/packages' }).commands.some((c) => c.startsWith('npm publish '))).toBe(false);
    expect(runPublish(tracker, { failBunCommand: 'run test' }).commands.some((c) => c.startsWith('npm publish '))).toBe(false);
  });

  test('runs the app scenarios on the packed tarballs before the first publish', () => {
    const { result, commands } = runPublish(tracker);
    expect(result.status).toBe(0);
    const pack = commands.indexOf(PACK);
    const apps = commands.indexOf('bun test/apps/run.ts --packages dist/packages');
    const publish = commands.findIndex((command) => command.startsWith('npm publish '));
    expect(pack).toBeLessThan(apps);
    expect(apps).toBeLessThan(publish);
  });

  test('the explicit rerun escape hatch skips the proofs and the pack, and uploads the tarballs they proved', () => {
    const { result, commands } = runPublish(tracker, { skip: true });
    expect(result.status).toBe(0);
    expect(commands).not.toContain('bun run test');
    expect(commands).not.toContain(PACKAGING_GATE);
    expect(commands).not.toContain('bun test/apps/run.ts --packages dist/packages');
    expect(commands.some((command) => command.startsWith(PACK))).toBe(false);
    expect(commands.filter((command) => command.startsWith('npm publish '))).toHaveLength(6);
  });

  test('the packaging gate given --packages neither builds nor packs', () => {
    const work = tracker.create('pkg-gate');
    const bin = join(work, 'bin');
    const packages = join(work, 'packages');
    mkdirSync(bin, { recursive: true });
    mkdirSync(packages, { recursive: true });
    const log = join(work, 'commands.log');
    writeFileSync(log, '');
    for (const command of ['bash', 'npm', 'bun']) {
      const path = join(bin, command);
      writeFileSync(path, `#!/bin/bash\necho "$(basename "$0") $*" >> "$COMMAND_LOG"\n`);
      chmodSync(path, 0o755);
    }
    writeFileSync(join(packages, 'manifest.json'), JSON.stringify({ packages: [] }));
    const result = spawnSync('/bin/bash', [join(root, 'scripts/packaging-test.sh'), '--packages', packages], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log, TMPDIR: work },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`build and pack skipped: testing the tarballs in ${packages}`);
    expect(result.stderr).toContain('names no packed @pyric/rules@');
    const commands = readFileSync(log, 'utf8');
    expect(commands).not.toContain('scripts/build.sh');
    expect(commands).not.toContain('pack-packages.sh');
    expect(commands).not.toContain('npm pack');
  });

  test('dry-run proves authentication and package shape without mutating the registry', () => {
    const { result, commands } = runPublish(tracker, { dryRun: true });
    expect(result.status).toBe(0);
    expect(commands).toContain('npm whoami --registry=https://registry.npmjs.org/');
    expect(commands.filter((command) => command.startsWith('npm publish '))).toHaveLength(6);
    expect(commands.filter((c) => c.startsWith('npm publish ')).every((c) => c.includes(' --dry-run'))).toBe(true);
    expect(commands).toContain('bun run compat:check');
    expect(commands).toContain('bun run packages/conformance/src/print-fb-tag.ts');
    expect(commands.some((command) => command.startsWith('npm dist-tag add '))).toBe(false);
  });

  test('the generated release checklists require preflight before publishing and open PRs with ci-packaging', () => {
    const script = readFileSync(join(root, 'scripts/prepare-release.sh'), 'utf8');
    const checklist = script.slice(script.indexOf('BODY_FILE='));
    expect(checklist.indexOf('bun run release:preflight --package rules')).toBeLessThan(
      checklist.indexOf('bash scripts/publish-alpha.sh --package rules'),
    );
    expect(checklist.lastIndexOf('bun run release:preflight')).toBeLessThan(
      checklist.lastIndexOf('bash scripts/publish-alpha.sh'),
    );
    expect(checklist).not.toContain('OTP-capable');
    expect(script).toContain('gh pr create');
    expect(script).toContain('--label ci-packaging');
  });

  test('the upload list, the lockstep version check and the release bump name the same six packages', () => {
    const tarballOf = (name: string) => name.replace(/^@/, '').replaceAll('/', '-');
    const publish = readFileSync(join(root, 'scripts/publish-alpha.sh'), 'utf8');
    const uploaded = /^TARBALLS=\(([^)]*)\)$/m.exec(publish)?.[1]?.split(' ') ?? [];
    const prepare = readFileSync(join(root, 'scripts/prepare-release.sh'), 'utf8');
    const bumpedDirs = /^\s*for dir in ([^;]*); do$/m.exec(prepare)?.[1]?.split(' ') ?? [];
    const bumped = bumpedDirs.map((dir) => (JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) as { name: string }).name);
    const checker = readFileSync(join(root, 'scripts/lib/check-publish-version.mjs'), 'utf8');
    const checkedDirs = [...checker.matchAll(/^ {2}'(packages\/[^']+)',$/gm)].map((match) => match[1] ?? '');
    const checked = checkedDirs.map((dir) => (JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as { name: string }).name);
    expect(uploaded).toContain('pyric-live');
    expect(uploaded).toHaveLength(6);
    const published = /^PACKAGES=\(([^)]*)\)$/m.exec(publish)?.[1]?.split(' ') ?? [];
    expect(published.map(tarballOf)).toEqual(uploaded);
    expect(bumped.map(tarballOf).sort()).toEqual([...uploaded].sort());
    expect(checked.map(tarballOf).sort()).toEqual([...uploaded].sort());
    for (const dir of [...bumpedDirs, 'rules']) {
      const manifest = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) as { private?: boolean };
      expect(manifest.private).toBeUndefined();
    }
  });

  test('supports next, exp, and default latest channels plus registry pinning', () => {
    const nextRun = runPublish(tracker, { skip: true, publishTag: 'next' });
    expect(nextRun.result.status).toBe(0);
    const nextTags = nextRun.commands.filter((c) => c.startsWith('npm dist-tag add '));
    expect(nextTags.every((c) => !c.endsWith(' latest') && !c.endsWith(' alpha'))).toBe(true);
    expect(nextTags.some((c) => c.endsWith(' next'))).toBe(true);

    const expRun = runPublish(tracker, { skip: true, publishTag: 'exp' });
    expect(expRun.result.status).toBe(0);
    expect(expRun.commands.filter((c) => c.startsWith('npm dist-tag add ')).every((c) => c.endsWith(' exp'))).toBe(true);
    expect(expRun.commands).not.toContain('bun run compat:check');
    expect(expRun.registries.every((r) => r === 'https://registry.npmjs.org/')).toBe(true);

    const latestRun = runPublish(tracker, { skip: true });
    expect(latestRun.result.status).toBe(0);
    const liveTags = latestRun.commands.filter((c) => c.startsWith('npm dist-tag add @pyric/live@0.1.0-alpha.9 '));
    expect(liveTags).toEqual([
      'npm dist-tag add @pyric/live@0.1.0-alpha.9 latest',
      'npm dist-tag add @pyric/live@0.1.0-alpha.9 alpha',
    ]);
    expect(latestRun.commands.some((c) => c.endsWith(' fb12.13'))).toBe(true);

    const custom = runPublish(tracker, { skip: true, publishTag: 'exp', npmRegistry: 'http://127.0.0.1:4873/' });
    expect(custom.registries.every((r) => r === 'http://127.0.0.1:4873/')).toBe(true);
  });
});

describe('@pyric/rules standalone release path (--package rules, #1521)', () => {
  const RULES_PACK = 'bash scripts/pack-packages.sh --package rules';
  const RULES_PROOF = 'bun scripts/lib/rules-release-gate.ts proof';
  const RULES_TARBALL_GATE = `bun scripts/lib/rules-release-gate.ts tarball ${join(root, 'dist/packages/pyric-rules-0.1.0.tgz')}`;
  const RULES_STANDALONE_APP = 'bun test/apps/run.ts --packages dist/packages rules-standalone';
  const RULES_STAMP_WRITE = `node ${join(root, 'scripts/lib/proven-stamp.mjs')} write ${join(root, 'dist/packages')} 0.1.0 ${root} pyric-rules`;
  const RULES_STAMP_VERIFY = `node ${join(root, 'scripts/lib/proven-stamp.mjs')} verify ${join(root, 'dist/packages')} 0.1.0 ${root} pyric-rules`;

  test('runs the rules proof, single-package pack, tarball gate, and rules-standalone scenario before stamping and uploading', () => {
    const { result, commands } = runPublish(tracker, { packageTarget: 'rules', version: '0.1.0' });
    expect(result.status).toBe(0);
    expect(commands[0]).toContain('check-publish-version.mjs --package rules 0.1.0');
    expect(commands.find((c) => c.includes('check-publish-access.mjs'))).toContain('@pyric/rules');
    const proof = commands.indexOf(RULES_PROOF);
    const pack = commands.indexOf(RULES_PACK);
    const tgzGate = commands.indexOf(RULES_TARBALL_GATE);
    const app = commands.indexOf(RULES_STANDALONE_APP);
    const stamp = commands.indexOf(RULES_STAMP_WRITE);
    const publish = commands.findIndex((c) => c.startsWith('npm publish '));
    expect(proof).toBeGreaterThanOrEqual(0);
    expect(proof).toBeLessThan(pack);
    expect(pack).toBeLessThan(tgzGate);
    expect(tgzGate).toBeLessThan(app);
    expect(app).toBeLessThan(stamp);
    expect(stamp).toBeLessThan(publish);

    const uploads = commands.filter((c) => c.startsWith('npm publish '));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toContain('/pyric-rules-0.1.0.tgz --tag latest --access public');
    expect(commands).not.toContain('bun run test');
    expect(commands).not.toContain('bun run compat:check');
    expect(commands.filter((c) => c.startsWith('npm dist-tag add '))).toEqual([
      'npm dist-tag add @pyric/rules@0.1.0 latest',
    ]);
    expect(result.stdout).toContain('git tag rules-v0.1.0 && git push origin rules-v0.1.0');
  });

  test('accepts --dry-run both before and after --package rules (for bun run release:preflight --package rules)', () => {
    for (const dryRunAfterPackage of [false, true]) {
      const { result, commands } = runPublish(tracker, {
        packageTarget: 'rules',
        dryRun: true,
        dryRunAfterPackage,
        version: '0.1.0',
      });
      expect(result.status).toBe(0);
      expect(commands).toContain('npm whoami --registry=https://registry.npmjs.org/');
      const uploads = commands.filter((c) => c.startsWith('npm publish '));
      expect(uploads).toHaveLength(1);
      expect(uploads[0]).toContain('--dry-run');
      expect(commands.some((c) => c.startsWith('npm dist-tag add '))).toBe(false);
      expect(result.stdout).toContain('Preflight complete. No packages or dist-tags were published or changed.');
      expect(result.stdout).toContain('rules-v0.1.0');
    }
  });

  test('any failed rules gate blocks upload, and PYRIC_PUBLISH_SKIP_GATES=1 verifies the single-tarball stamp', () => {
    for (const failBunCommand of [
      'scripts/lib/rules-release-gate.ts proof',
      `scripts/lib/rules-release-gate.ts tarball ${join(root, 'dist/packages/pyric-rules-0.1.0.tgz')}`,
      'test/apps/run.ts --packages dist/packages rules-standalone',
    ]) {
      const failed = runPublish(tracker, { packageTarget: 'rules', failBunCommand });
      expect(failed.result.status).toBe(17);
      expect(failed.commands.some((c) => c.startsWith('npm publish '))).toBe(false);
    }

    const skipped = runPublish(tracker, { packageTarget: 'rules', skip: true, publishTag: 'exp' });
    expect(skipped.result.status).toBe(0);
    expect(skipped.commands).toContain(RULES_STAMP_VERIFY);
    expect(skipped.commands).not.toContain(RULES_PROOF);
    expect(skipped.commands).not.toContain(RULES_PACK);
    expect(skipped.commands.filter((c) => c.startsWith('npm dist-tag add '))).toEqual([
      'npm dist-tag add @pyric/rules@0.1.0 exp',
    ]);
  });

  test('real stamp + access check refuses a brand-new @pyric/rules until PYRIC_PUBLISH_SCOPE_WRITE=@pyric is set', () => {
    const repo = realStampRepo(tracker);
    const refused = publishForReal(
      repo,
      { ACCESS_JSON: ALL_READ_WRITE, NEW_PACKAGES: '@pyric/rules' },
      { packageTarget: 'rules', version: '0.1.0' },
    );
    expect(refused.result.status).toBe(1);
    expect(refused.result.stderr).toContain('@pyric/rules');
    expect(refused.result.stderr).toContain('PYRIC_PUBLISH_SCOPE_WRITE=@pyric');
    expect(refused.uploads).toEqual([]);

    const allowed = publishForReal(
      repo,
      { ACCESS_JSON: ALL_READ_WRITE, NEW_PACKAGES: '@pyric/rules', PYRIC_PUBLISH_SCOPE_WRITE: '@pyric' },
      { packageTarget: 'rules', version: '0.1.0' },
    );
    expect(allowed.result.status).toBe(0);
    expect(allowed.uploads).toEqual(['uploaded pyric-rules-0.1.0.tgz packed pyric-rules']);
  }, 15_000);

  test('pack-packages.sh --package rules writes a single-package manifest and pinPyricPackages fails closed on missing packages', async () => {
    const out = tracker.create('rules-pack-out');
    const packed = runPack(tracker, out, { npm: NPM_PACK_STUB }, ['--package', 'rules']);
    expect(packed.status).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['manifest.json', 'pyric-rules-0.1.0.tgz']);
    const resolved = tarballsIn(root, out);
    expect([...resolved.keys()]).toEqual(['@pyric/rules']);

    const standaloneApp = tracker.create('standalone-app');
    writeFileSync(join(standaloneApp, 'package.json'), JSON.stringify({ private: true, devDependencies: { '@pyric/rules': '*' } }));
    pinPyricPackages(standaloneApp, resolved);
    expect(readFileSync(join(standaloneApp, 'package.json'), 'utf8')).toContain('file:');

    const fullApp = tracker.create('full-app');
    writeFileSync(join(fullApp, 'package.json'), JSON.stringify({ private: true, dependencies: { pyric: '*', '@pyric/cli': '*' } }));
    expect(() => pinPyricPackages(fullApp, resolved)).toThrow('missing packed package pyric in tarball set');

    const tmpRoot = tracker.create('tgz-fail-root');
    const previousTmpRoot = process.env.PYRIC_TEST_TMP_ROOT;
    process.env.PYRIC_TEST_TMP_ROOT = tmpRoot;
    try {
      await expect(checkRulesTarball(join(out, 'pyric-rules-0.1.0.tgz'))).rejects.toThrow();
      expect(readdirSync(tmpRoot)).toEqual([]);
    } finally {
      if (previousTmpRoot === undefined) delete process.env.PYRIC_TEST_TMP_ROOT;
      else process.env.PYRIC_TEST_TMP_ROOT = previousTmpRoot;
    }
  }, 15_000);

  test('browser bundle gate catches Node built-in imports outside /internal/node', async () => {
    expect(isNodeBuiltinSpecifier('node:fs')).toBe(true);
    expect(isNodeBuiltinSpecifier('fs/promises')).toBe(true);
    expect(isNodeBuiltinSpecifier('ohm-js')).toBe(false);
    expect(isNodeBuiltinSpecifier('@pyric/rules')).toBe(false);

    const fakeWork = tracker.create('browser-gate');
    const pkgDir = join(fakeWork, 'node_modules/@pyric/rules');
    mkdirSync(join(pkgDir, 'dist/internal'), { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@pyric/rules',
        version: '0.1.0',
        type: 'module',
        exports: {
          '.': { import: './dist/index.js' },
          './internal/node': { import: './dist/internal/node.js' },
        },
      }),
    );
    writeFileSync(join(pkgDir, 'dist/internal/node.js'), "import { readFileSync } from 'node:fs';\nexport { readFileSync };\n");
    writeFileSync(join(pkgDir, 'dist/index.js'), 'export const ok = 1;\n');
    expect(await verifyBrowserBundlesHaveNoNodeBuiltins(fakeWork, pkgDir)).toEqual([]);

    writeFileSync(join(pkgDir, 'dist/index.js'), "import { readFileSync } from 'node:fs';\nexport { readFileSync };\n");
    const violations = await verifyBrowserBundlesHaveNoNodeBuiltins(fakeWork, pkgDir);
    expect(violations.some((v) => v.includes("imports Node built-in 'node:fs'"))).toBe(true);
  });

  test('planRulesProofJobs isolates heavy property files without dropping or duplicating any rules test', () => {
    const rulesJobs = planRulesProofJobs(root).filter((j) => j.runsBunTest && j.name.startsWith('rules '));
    const plannedFiles = rulesJobs.flatMap((j) => j.args.slice(1));
    expect(plannedFiles.slice(0, ISOLATED_RULES_FILES.length)).toEqual([...ISOLATED_RULES_FILES]);
    expect(rulesJobs.slice(0, ISOLATED_RULES_FILES.length).every((j) => j.expectedFiles === 1)).toBe(true);
    expect([...plannedFiles].sort()).toEqual([...listTests('packages/rules')].sort());
  });

  test('prepare-release.sh --package rules bumps only packages/rules and opens a rules-v PR', () => {
    const fx = setupPrepareReleaseRepo(tracker, 'prep-rules');
    const run = fx.runPrepare(['--package', 'rules', '0.1.1']);
    expect(run.status).toBe(0);
    expect(fx.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('release/rules-v0.1.1');
    expect(fx.git('log', '-n', '1', '--format=%s')).toBe('release: rules-v0.1.1');
    expect((JSON.parse(readFileSync(join(fx.clone, 'packages/rules/package.json'), 'utf8')) as { version: string }).version).toBe('0.1.1');
    expect((JSON.parse(readFileSync(join(fx.clone, 'packages/pyric/package.json'), 'utf8')) as { version: string }).version).toBe('0.1.0-alpha.35');
    expect(readFileSync(fx.ghLog, 'utf8')).toContain('gh pr create --base main --head release/rules-v0.1.1 --title release: rules-v0.1.1');
    expect(readFileSync(fx.ghLog, 'utf8')).toContain('--label ci-packaging');

    const badPrep = fx.runPrepare(['0.1.2', '--package', 'rules']);
    expect(badPrep.status).toBe(2);
    expect(fx.runPrepare(['--base', '', '0.1.2']).status).toBe(2);
    expect((JSON.parse(readFileSync(join(fx.clone, 'packages/pyric/package.json'), 'utf8')) as { version: string }).version).toBe('0.1.0-alpha.35');
    const badPub = spawnSync('/bin/bash', [join(root, 'scripts/publish-alpha.sh'), '0.1.0', '--package', 'rules'], { cwd: root, encoding: 'utf8' });
    expect(badPub.status).toBe(2);
  }, 15_000);

  test('prepare-release.sh --base <ref> cuts rules or pyric from a pinned commit, publishes cleanly, and back-syncs tag ancestry to main', () => {
    const fx = setupPrepareReleaseRepo(tracker, 'prep-pinned-base', { legacyInitialPrepare: true });
    const pinSha = fx.git('rev-parse', 'HEAD');
    fx.git('tag', '-a', 'rc/0.1.0-alpha.36', '-m', 'pin rc', pinSha);
    fx.git('push', '-q', 'origin', 'rc/0.1.0-alpha.36');
    advanceMainPastHistoricalPin(fx, pinSha);

    // P1->P2 guard: detached historical pin lacks --base; switching back to main runs current prepare-release.sh cleanly across checkout.
    fx.git('checkout', '-q', '--detach', 'rc/0.1.0-alpha.36');
    expect(fx.runPrepare(['--base', 'rc/0.1.0-alpha.36', '0.1.0-alpha.36']).status).toBe(2);
    fx.git('checkout', '-q', 'main');

    // Non-ancestor --base must fail closed without pushing any release-base/* branch.
    fx.git('checkout', '-q', '-b', 'unmerged-side', pinSha);
    writeFileSync(join(fx.clone, 'side.txt'), 'unmerged\n');
    fx.git('add', 'side.txt');
    fx.git('commit', '-q', '-m', 'feat: unmerged commit');
    const sideSha = fx.git('rev-parse', 'HEAD');
    fx.git('checkout', '-q', 'main');
    const rejected = fx.runPrepare(['--base', sideSha, '0.1.0-alpha.36']);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('is not an ancestor of origin/main');
    expect(spawnSync('git', ['--git-dir', fx.remote, 'rev-parse', '--verify', 'refs/heads/release-base/v0.1.0-alpha.36']).status).not.toBe(0);

    // 1) --package rules --base historical-pin resolves an unfetched remote branch via FETCH_HEAD and keeps CHANGELOG + frozen-lockfile checklist.
    const rulesCut = fx.runPrepare(['--package', 'rules', '--base', 'historical-pin', '0.1.1']);
    expect(rulesCut.status).toBe(0);
    expect(fx.git('rev-parse', 'HEAD^1')).toBe(pinSha);
    expect(spawnSync('git', ['--git-dir', fx.remote, 'rev-parse', 'refs/heads/release-base/rules-v0.1.1'], { encoding: 'utf8' }).stdout.trim()).toBe(pinSha);
    expect(readFileSync(fx.ghLog, 'utf8')).toContain('gh pr create --base release-base/rules-v0.1.1 --head release/rules-v0.1.1');
    expect(readFileSync(join(fx.prBodiesDir, 'body-0.md'), 'utf8')).toContain('packages/rules/CHANGELOG.md');

    // 2) Lockstep --base=rc/0.1.0-alpha.36 cuts 0.1.0-alpha.36 on pinSha, proves proven-stamp + detached publish, and back-syncs to main.
    fx.git('checkout', '-q', 'main');
    const pyricCut = fx.runPrepare(['--base=rc/0.1.0-alpha.36', '0.1.0-alpha.36']);
    expect(pyricCut.status).toBe(0);
    expect(fx.git('rev-parse', 'HEAD^1')).toBe(pinSha);
    expect(readdirSync(join(fx.clone, 'packages/pyric'))).not.toContain('unreleased.txt');
    const prBody0 = readFileSync(join(fx.prBodiesDir, 'body-1.md'), 'utf8');
    expect(prBody0).not.toContain('post-pin unreleased main feature');
    expect(prBody0).toContain('origin/release-base/v0.1.0-alpha.36 && bun install --frozen-lockfile');

    // Merge release/v0.1.0-alpha.36 into release-base/v0.1.0-alpha.36 as GitHub PR merge does, detach, stamp, and run publish-alpha.sh.
    fx.git('fetch', '-q', 'origin', 'release-base/v0.1.0-alpha.36');
    fx.git('checkout', '-q', '-B', 'release-base/v0.1.0-alpha.36', 'origin/release-base/v0.1.0-alpha.36');
    fx.git('merge', '-q', '--no-ff', 'release/v0.1.0-alpha.36', '-m', 'Merge pull request #1 from release/v0.1.0-alpha.36');
    fx.git('push', '-q', 'origin', 'release-base/v0.1.0-alpha.36');
    fx.git('checkout', '-q', '--detach', 'origin/release-base/v0.1.0-alpha.36');
    const publishedSha = fx.git('rev-parse', 'HEAD');
    const pub = stampAndPublishDetached(fx, '0.1.0-alpha.36');
    expect(pub.status).toBe(0);
    expect(readFileSync(fx.ghLog, 'utf8')).toContain('npm dist-tag add pyric@0.1.0-alpha.36 exp');

    // Tag publishedSha, back-merge v0.1.0-alpha.36 into main, then cut 0.1.0-alpha.37 from main: changelog must list only post-pin commit.
    fx.git('tag', 'v0.1.0-alpha.36', publishedSha);
    fx.git('push', '-q', 'origin', 'v0.1.0-alpha.36');
    fx.git('checkout', '-q', 'main');
    fx.git('merge', '-q', '--no-ff', 'v0.1.0-alpha.36', '-m', 'chore(release): sync v0.1.0-alpha.36 version bump to main');
    fx.git('push', '-q', 'origin', 'main');

    const nextCut = fx.runPrepare(['0.1.0-alpha.37'], { PUBLISHED_ON_NPM: '' });
    expect(nextCut.status).toBe(0);
    const nextBody = readFileSync(join(fx.prBodiesDir, 'body-2.md'), 'utf8');
    expect(nextBody).toContain('## Changes since v0.1.0-alpha.36');
    expect(nextBody).toContain('post-pin unreleased main feature');
    expect(nextBody).not.toContain('initial engine');
  }, 20_000);
});

describe('the proven-tarball stamp', () => {
  test('every gate passes, then the tarballs are stamped, then the first upload', () => {
    const { result, commands } = runPublish(tracker);
    expect(result.status).toBe(0);
    const apps = commands.indexOf('bun test/apps/run.ts --packages dist/packages');
    const stamp = commands.indexOf(STAMP_WRITE);
    const publish = commands.findIndex((command) => command.startsWith('npm publish '));
    expect(apps).toBeLessThan(stamp);
    expect(stamp).toBeLessThan(publish);
    expect(commands).not.toContain(STAMP_VERIFY);
  });

  test('a gate-skipping rerun checks the stamp first and refuses tampered tarballs', () => {
    const { result, commands } = runPublish(tracker, { skip: true });
    expect(result.status).toBe(0);
    const verify = commands.indexOf(STAMP_VERIFY);
    const smoke = commands.findIndex((command) => command.startsWith('bash scripts/release-smoke.sh'));
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(verify).toBeLessThan(smoke);
    expect(commands).not.toContain(STAMP_WRITE);

    const bad = runPublish(tracker, { skip: true, failCommand: STAMP_VERIFY });
    expect(bad.result.status).toBe(17);
    expect(bad.commands.some((command) => command.startsWith('npm publish '))).toBe(false);
  });

  test('real stamp inside publish-alpha.sh rejects mid-gate swaps, protects against post-check swaps, and clears stamp on failure', () => {
    expect(publishForReal(realStampRepo(tracker)).uploads).toEqual(PACKED_UPLOADS);

    const midgate = publishForReal(realStampRepo(tracker), { MIDGATE: '1' });
    expect(midgate.result.status).toBe(1);
    expect(midgate.result.stderr).toContain('pyric-cli-0.1.0-alpha.9.tgz is not the file the pack names');
    expect(midgate.uploads).toEqual([]);

    const race = publishForReal(realStampRepo(tracker), { RACE: '1' });
    expect(race.result.status).toBe(0);
    expect(race.uploads).toEqual(PACKED_UPLOADS);

    const repo = realStampRepo(tracker);
    expect(publishForReal(repo).result.status).toBe(0);
    expect(publishForReal(repo, { TESTS_FAIL: '1' }).result.status).toBe(1);
    const rerun = publishForReal(repo, { PYRIC_PUBLISH_SKIP_GATES: '1' });
    expect(rerun.result.status).toBe(1);
    expect(rerun.result.stderr).toContain('no gate run proved these tarballs');
    expect(rerun.uploads).toEqual([]);
  }, 30_000);
});

describe('publish access is checked for every package before any gate or upload (#2029)', () => {
  test('enforces read-write access, scope acknowledgement for new packages, collaborator fallback, and non-404 errors', () => {
    const ok = publishForReal(realStampRepo(tracker));
    expect(ok.result.status).toBe(0);
    expect(ok.commands).toContain('npm access list packages releaser --json');
    expect(ok.uploads).toEqual(PACKED_UPLOADS);

    const newRefused = publishForReal(realStampRepo(tracker), { ACCESS_JSON: FIVE_EXISTING, NEW_PACKAGES: '@pyric/live' });
    expect(newRefused.result.status).toBe(1);
    expect(newRefused.result.stderr).toContain('PYRIC_PUBLISH_SCOPE_WRITE=@pyric');
    expect(newRefused.commands).not.toContain('bun run test');

    const newAck = publishForReal(realStampRepo(tracker), { ACCESS_JSON: FIVE_EXISTING, NEW_PACKAGES: '@pyric/live', PYRIC_PUBLISH_SCOPE_WRITE: '@pyric' });
    expect(newAck.result.status).toBe(0);
    expect(newAck.uploads).toEqual(PACKED_UPLOADS);

    expect(publishForReal(realStampRepo(tracker), { ACCESS_JSON: FIVE_EXISTING, NEW_PACKAGES: '@pyric/live', PYRIC_PUBLISH_SCOPE_WRITE: '@other' }).result.status).toBe(1);

    const readOnly = JSON.stringify({ ...JSON.parse(ALL_READ_WRITE), 'pyric-admin': 'read-only' });
    expect(publishForReal(realStampRepo(tracker), { ACCESS_JSON: readOnly, PYRIC_PUBLISH_SCOPE_WRITE: '@pyric' }).result.status).toBe(1);

    const missingUi = accessJson(PUBLISHED_NAMES.filter((name) => name !== '@pyric/ui'));
    expect(publishForReal(realStampRepo(tracker), { ACCESS_JSON: missingUi }).result.status).toBe(1);

    const collabOk = publishForReal(realStampRepo(tracker), { LISTING_FAILS: '1', COLLABORATORS_JSON: JSON.stringify({ releaser: 'read-write', someone: 'read-only' }) });
    expect(collabOk.result.status).toBe(0);
    expect(collabOk.commands).toContain('npm access list collaborators @pyric/live --json');

    expect(publishForReal(realStampRepo(tracker), { LISTING_FAILS: '1', COLLABORATORS_FAIL: '1' }).result.status).toBe(1);
    expect(publishForReal(realStampRepo(tracker), { LISTING_FAILS: '1', COLLABORATORS_JSON: JSON.stringify({ releaser: 'read-only' }) }).result.status).toBe(1);
    expect(publishForReal(realStampRepo(tracker), { ACCESS_JSON: 'null' }).result.stderr).not.toContain('TypeError');
    expect(publishForReal(realStampRepo(tracker), { ACCESS_JSON: FIVE_EXISTING, VIEW_FAILS: '@pyric/live', PYRIC_PUBLISH_SCOPE_WRITE: '@pyric' }).result.status).toBe(1);

    for (const options of [{}, { dryRun: true }, { skip: true }]) {
      const { result, commands } = runPublish(tracker, options);
      expect(result.status).toBe(0);
      const check = commands.findIndex((command) => command.includes('scripts/lib/check-publish-access.mjs'));
      const smoke = commands.findIndex((command) => command.startsWith('bash scripts/release-smoke.sh'));
      expect(check).toBeLessThan(smoke);
    }
  }, 30_000);
});

describe('a pack that fails or is interrupted leaves no tarball behind', () => {
  test('a failed build or broken source map removes older tarballs and keeps unrelated files', () => {
    const out1 = staleOutDir(tracker);
    expect(runPack(tracker, out1, { bash: 'exit 17' }).status).not.toBe(0);
    expect(readdirSync(out1).sort()).toEqual(['notes.txt']);

    const out2 = staleOutDir(tracker);
    const broken = runPack(tracker, out2, {
      npm: NPM_PACK_STUB,
      node: `if [[ "$1" == *verify-published-sourcemaps.mjs ]] && grep -q '"name": "pyric-admin"' "$2/package.json"; then echo "broken source map" >&2; exit 3; fi\nexec ${REAL_NODE} "$@"`,
    });
    expect(broken.status).not.toBe(0);
    expect(broken.stderr).toContain('broken source map');
    expect(readdirSync(out2).sort()).toEqual(['notes.txt']);
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    test(`${signal} during the build clears the older pack and its stamp`, async () => {
      const out = staleOutDir(tracker);
      const work = tracker.create('pack-sig');
      const bin = join(work, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'bash'), '#!/bin/bash\nexec sleep 30\n');
      chmodSync(join(bin, 'bash'), 0o755);
      const pack = spawn('/bin/bash', [join(root, 'scripts/pack-packages.sh'), '--out', out], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
      process.kill(-(pack.pid ?? 0), signal);
      const code = await new Promise<number | null>((resolvePromise) =>
        pack.once('close', (exitCode) => resolvePromise(exitCode)),
      );
      expect(code).not.toBe(0);
      expect(readdirSync(out).sort()).toEqual(['notes.txt']);
    }, 15_000);
  }
});
