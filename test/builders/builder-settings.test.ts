import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builderSettingsProblems, SETTINGS_TEMPLATE } from './builder-settings.ts';

function settingsFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'builders-settings-')), 'builder.settings.json');
  writeFileSync(path, content);
  return path;
}

describe('the settings template', () => {
  test('passes the check round makes, and allows only the builder’s tools', () => {
    expect(builderSettingsProblems(SETTINGS_TEMPLATE)).toEqual([]);
    const template = JSON.parse(readFileSync(SETTINGS_TEMPLATE, 'utf8')) as { permissions: { allow: string[]; deny: string[] } };
    expect(template.permissions.allow).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite']);
    expect(template.permissions.deny).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch', 'Bash(gh:*)', 'Bash(git push:*)']));
  });
});

describe('builderSettingsProblems', () => {
  test('says how to start from the template when the file is missing', () => {
    const path = join(tmpdir(), 'nowhere', 'builder.settings.json');
    expect(builderSettingsProblems(path)).toEqual([`the builder settings file ${path} does not exist: start from the template with \`cp ${SETTINGS_TEMPLATE} ${path}\``]);
  });

  test('refuses a file that is not JSON', () => {
    const path = settingsFile('{ permissions');
    const problems = builderSettingsProblems(path);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith(`the builder settings file ${path}: not JSON: `);
  });

  test('refuses a file with no permissions, or empty or non-string rule lists', () => {
    const empty = settingsFile('{}');
    expect(builderSettingsProblems(empty)).toEqual([`the builder settings file ${empty}: permissions: Required`]);
    const noRules = settingsFile(JSON.stringify({ permissions: { allow: [], deny: ['WebFetch', 3] } }));
    expect(builderSettingsProblems(noRules)).toEqual([
      `the builder settings file ${noRules}: permissions.allow: Array must contain at least 1 element(s)`,
      `the builder settings file ${noRules}: permissions.deny.1: Expected string, received number`,
    ]);
    const noDeny = settingsFile(JSON.stringify({ permissions: { allow: ['Read'] } }));
    expect(builderSettingsProblems(noDeny)).toEqual([`the builder settings file ${noDeny}: permissions.deny: Required`]);
  });
});
