#!/usr/bin/env bun
/**
 * Cut a GitHub release of the standalone `pyric` binaries.
 *
 * Compiles all four targets (via scripts/compile.ts), writes a SHA256SUMS, and
 * creates-or-updates a GitHub release with the binaries + checksums attached.
 * Idempotent: re-running the same tag re-uploads assets (`--clobber`).
 *
 * Pre-req: `bun run build` (compile.ts needs a fresh dist/). Then:
 *   bun scripts/release.ts                 # tag standalone-v<version>, prerelease
 *   bun scripts/release.ts --tag v0.1.0 --stable
 *   bun scripts/release.ts --skip-compile  # reuse dist-bin/ as-is
 *   bun scripts/release.ts --dry-run       # print the plan, touch nothing
 *
 * Flags: --tag <t> | --stable (full release, default prerelease) | --draft |
 *        --target <commitish> | --repo <owner/repo> | --skip-compile | --dry-run
 *
 * The root `release:standalone` script runs `bun run build` first.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(PKG_ROOT, 'dist-bin');
const BINARIES = ['pyric-linux-x64', 'pyric-linux-arm64', 'pyric-darwin-x64', 'pyric-darwin-arm64'];

function die(msg: string): never {
  process.stderr.write(`release: ${msg}\n`);
  process.exit(1);
}

// ── args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const version = (
  JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as { version?: string }
).version ?? '0.0.0';
const tag = opt('tag') ?? `standalone-v${version}`;
const prerelease = !flag('stable');
const draft = flag('draft');
const skipCompile = flag('skip-compile');
const dryRun = flag('dry-run');
const repo = opt('repo');
const target = opt('target');

const run = (cmd: string, args: string[], label: string): void => {
  if (dryRun) {
    process.stdout.write(`  [dry-run] ${cmd} ${args.join(' ')}\n`);
    return;
  }
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], cwd: PKG_ROOT });
  if (r.status !== 0) die(`${label} failed (exit ${r.status})`);
};

// ── 1. compile ────────────────────────────────────────────────────────
if (!skipCompile) {
  process.stdout.write('▸ compiling all targets…\n');
  run(process.execPath, ['scripts/compile.ts'], 'compile');
}
const missing = BINARIES.filter((b) => !existsSync(join(OUT, b)));
if (missing.length && !dryRun) die(`missing binaries: ${missing.join(', ')} (run without --skip-compile)`);

// ── 2. checksums ──────────────────────────────────────────────────────
const sumsPath = join(OUT, 'SHA256SUMS');
if (!dryRun) {
  const lines = BINARIES.map((b) => {
    const hash = createHash('sha256').update(readFileSync(join(OUT, b))).digest('hex');
    return `${hash}  ${b}`;
  });
  writeFileSync(sumsPath, lines.join('\n') + '\n');
  process.stdout.write(`▸ wrote SHA256SUMS\n`);
}

// ── 3. notes ──────────────────────────────────────────────────────────
const notes = `Self-contained \`pyric\` CLI built with \`bun build --compile\`: no Node, no npm. \`serve\` runs fully offline; \`pyric init\` vendors the unpublished \`pyric\`/\`pyric-tools\` so a scaffold installs without publishing.

### Download (macOS Apple Silicon)
\`\`\`bash
gh release download ${tag} --repo ${repo ?? '<owner>/<repo>'} -p pyric-darwin-arm64 -O pyric
chmod +x ./pyric && xattr -d com.apple.quarantine ./pyric 2>/dev/null
./pyric --version
\`\`\`
Other arches: \`pyric-darwin-x64\`, \`pyric-linux-x64\`, \`pyric-linux-arm64\`. Verify with the attached \`SHA256SUMS\` (\`shasum -a 256 -c SHA256SUMS --ignore-missing\`).
`;
const notesPath = join(OUT, '.release-notes.md');
if (!dryRun) writeFileSync(notesPath, notes);

// ── 4. create-or-update the release, upload assets ────────────────────
const repoArgs = repo ? ['--repo', repo] : [];
const exists =
  !dryRun &&
  spawnSync('gh', ['release', 'view', tag, ...repoArgs], { stdio: 'ignore', cwd: PKG_ROOT }).status === 0;

if (exists) {
  process.stdout.write(`▸ release ${tag} exists: updating assets\n`);
} else {
  process.stdout.write(`▸ creating release ${tag}${prerelease ? ' (prerelease)' : ''}${draft ? ' (draft)' : ''}\n`);
  run(
    'gh',
    [
      'release',
      'create',
      tag,
      ...repoArgs,
      ...(target ? ['--target', target] : []),
      ...(prerelease ? ['--prerelease'] : []),
      ...(draft ? ['--draft'] : []),
      '--title',
      `pyric standalone CLI: ${tag}`,
      '--notes-file',
      dryRun ? '<notes>' : notesPath,
    ],
    'gh release create',
  );
}

const assetPaths = [...BINARIES, 'SHA256SUMS'].map((a) => join(OUT, a));
run('gh', ['release', 'upload', tag, ...repoArgs, ...assetPaths, '--clobber'], 'gh release upload');

process.stdout.write(`\n✅ released ${tag}\n`);
