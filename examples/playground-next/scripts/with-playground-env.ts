import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

function readGitPath(args: string[]): string | null {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (!proc.success) return null;
  const value = proc.stdout.toString().trim();
  return value.length > 0 ? value : null;
}

function repoRoot(): string {
  return readGitPath(['rev-parse', '--show-toplevel']) ?? resolve(process.cwd(), '../..');
}

function commonCheckoutRoot(root: string): string | null {
  const commonDir = readGitPath(['rev-parse', '--git-common-dir']);
  if (!commonDir) return null;
  const absolute = isAbsolute(commonDir) ? commonDir : resolve(root, commonDir);
  return dirname(absolute);
}

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = normalized.indexOf('=');
    if (eq <= 0) continue;
    const key = normalized.slice(0, eq).trim();
    let value = normalized.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function envFiles(): string[] {
  const root = repoRoot();
  const files: string[] = [];
  if (process.env.PLAYGROUND_ENV_FILE) {
    files.push(resolve(process.env.PLAYGROUND_ENV_FILE));
  }
  const commonRoot = commonCheckoutRoot(root);
  if (commonRoot) files.push(resolve(commonRoot, '.env'));
  files.push(resolve(root, '.env'));
  files.push(resolve(process.cwd(), '.env'));
  return Array.from(new Set(files)).filter((path) => existsSync(path));
}

function resolveCommand(command: string): string {
  if (isAbsolute(command) || command.includes(sep)) return command;
  const candidates = [
    resolve(process.cwd(), 'node_modules/.bin', command),
    resolve(repoRoot(), 'node_modules/.bin', command),
  ];
  return candidates.find((path) => existsSync(path)) ?? command;
}

const command = Bun.argv.slice(2);
if (command.length === 0) {
  console.error('usage: bun scripts/with-playground-env.ts <command> [...args]');
  process.exit(1);
}

const fileEnv: Record<string, string> = {};
for (const path of envFiles()) {
  Object.assign(fileEnv, parseEnvFile(path));
}

const child = Bun.spawn([resolveCommand(command[0]!), ...command.slice(1)], {
  cwd: process.cwd(),
  env: { ...fileEnv, ...process.env },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

const exitCode = await child.exited;
process.exit(exitCode);
