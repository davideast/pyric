/**
 * Puts the factory's UI rules where builders run them: `npx ast-grep scan -c
 * studio/checks/sgconfig.yml` from the app repo. The rules and their util are
 * copied into `studio/checks/factory-rules/` and `factory-utils/`, kept out of
 * git by the clone's `.git/info/exclude`; Studio's config names both, in the
 * run's start commit. They are warnings there, so Studio's own scan still
 * passes on its existing code.
 *
 * Builders can edit their copy; the gate never reads it. It runs the rules in
 * this directory (`ui-gates.ts`).
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_RULES = fileURLToPath(new URL('./ui-rules', import.meta.url));
const RULE_DIR = 'factory-rules';
const UTIL_DIR = 'factory-utils';
const EXCLUDED = [`studio/checks/${RULE_DIR}/`, `studio/checks/${UTIL_DIR}/`];

function copyYaml(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const file of readdirSync(from).filter((name) => name.endsWith('.yml'))) copyFileSync(join(from, file), join(to, file));
}

/** Copies the rules into a checkout and keeps them out of its git status. */
export function installUiRules(repo: string): void {
  const checks = join(repo, 'studio', 'checks');
  copyYaml(join(UI_RULES, 'rules'), join(checks, RULE_DIR));
  copyYaml(join(UI_RULES, 'utils'), join(checks, UTIL_DIR));
  const exclude = join(repo, '.git', 'info', 'exclude');
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  const missing = EXCLUDED.filter((line) => !current.split('\n').includes(line));
  if (missing.length > 0) appendFileSync(exclude, `${current.endsWith('\n') || current === '' ? '' : '\n'}${missing.join('\n')}\n`);
}

/** Names the rule and util directories in Studio's ast-grep config. */
export function registerUiRules(studio: string): void {
  const config = join(studio, 'checks', 'sgconfig.yml');
  const text = readFileSync(config, 'utf8');
  if (text.includes(RULE_DIR)) return;
  const ruleDirs = 'ruleDirs:\n  - rules\n';
  if (!text.includes(ruleDirs)) throw new Error(`${config} has no "ruleDirs: - rules" block to add the factory's rules to`);
  const hasUtilDirs = text.includes('utilDirs:');
  if (hasUtilDirs) throw new Error(`${config} already has utilDirs; add ${UTIL_DIR} by hand`);
  writeFileSync(config, text.replace(ruleDirs, `${ruleDirs}  - ${RULE_DIR}\nutilDirs:\n  - ${UTIL_DIR}\n`));
}
