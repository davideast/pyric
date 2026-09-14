import { spawnSync } from 'node:child_process';

// A separate process prevents Firebase app registries and browser globals in
// one baseline file from changing the next file's starting state.
const files = process.argv.slice(2);
const hasNoFiles = files.length === 0;
if (hasNoFiles) {
  console.error('Usage: bun scripts/test-isolated.ts <test-file>...');
  process.exit(1);
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['test', file], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const exitCode = result.status ?? 1;
  const failed = exitCode !== 0;
  if (failed) process.exit(exitCode);
  const hasIncompleteTests = /^\s+[1-9]\d* (?:skip|todo)\b/m.test(stderr);
  if (hasIncompleteTests) {
    console.error(`Skipped or unfinished tests cannot pass the isolated baseline: ${file}`);
    process.exit(1);
  }
}
