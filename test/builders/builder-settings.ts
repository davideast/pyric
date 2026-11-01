/**
 * `builder.settings.json`, the Claude Code permission file every `claude -p`
 * builder runs with (`--settings`). The template ships beside this file
 * (`builder.settings.template.json`); the copy a round uses lives in the
 * data root. Under `claude -p` nothing can answer a permission prompt, so a
 * tool the file does not allow is denied. `round` checks the file's shape
 * before it spends anything.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseJsonText, parseWith } from './parse.ts';

export const SETTINGS_TEMPLATE = fileURLToPath(new URL('./builder.settings.template.json', import.meta.url));

const rule = z.string().min(1);

const settingsSchema = z.object({
  permissions: z.object({
    allow: z.array(rule).min(1),
    deny: z.array(rule).min(1),
  }),
});

/** The command that puts the template where `round` reads the settings. */
export const settingsSetupCommand = (path: string) => `cp ${SETTINGS_TEMPLATE} ${path}`;

/** What is wrong with the settings file at `path`; empty when `round` can use it. */
export function builderSettingsProblems(path: string | undefined): string[] {
  if (path === undefined) return ['the builder settings file (none) does not exist'];
  if (!existsSync(path)) return [`the builder settings file ${path} does not exist: start from the template with \`${settingsSetupCommand(path)}\``];
  const json = parseJsonText(readFileSync(path, 'utf8'));
  const parsed = json.ok ? parseWith(settingsSchema, json.value) : json;
  if (parsed.ok) return [];
  return parsed.errors.map((error) => `the builder settings file ${path}: ${error}`);
}
