#!/usr/bin/env node
/**
 * `create-pyric` — `npm create pyric [dir]` / `npx create-pyric [dir]`.
 *
 * Always scaffolds with registry deps (npm). Default template is `web`
 * (Vite + `@pyric/cli/vite`).
 */

import { parseCreateArgs } from './parse-args.js';
import { applyDepsMode, normalizeBoolFlags, runScaffold, TEMPLATES } from './scaffold.js';
import { readFileSync } from 'node:fs';

function packageVersion(): string {
  const metadata = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown };
  if (typeof metadata.version !== 'string' || metadata.version.length === 0) {
    throw new Error('create-pyric package metadata has no version');
  }
  return metadata.version;
}

async function main(): Promise<number> {
  const args = parseCreateArgs(process.argv.slice(2));
  normalizeBoolFlags(args.flags, args.positional);

  if (args.flags.get('help') === true || args.flags.get('h') === true) {
    process.stdout.write(
      `Usage: npm create pyric [dir] [--template web|node|static] [--name N] [--force] [--json]\n` +
        `       npx create-pyric [dir] [flags]\n\n` +
        `Default template is web (Vite + @pyric/cli/vite).\n` +
        `Directory: optional positional; omit to scaffold in the current directory.\n`,
    );
    return 0;
  }

  const templateFlag = args.flags.get('template');
  const templateName = typeof templateFlag === 'string' ? templateFlag : 'web';
  if (templateName !== 'web' && templateName !== 'node' && templateName !== 'static') {
    process.stderr.write(
      `create-pyric: unknown template '${templateName}' (expected web|node|static)\n`,
    );
    return 1;
  }

  const nameFlag = args.flags.get('name');
  const name = typeof nameFlag === 'string' && nameFlag.length > 0 ? nameFlag : undefined;

  const version = packageVersion();
  const effectiveTemplate = applyDepsMode(TEMPLATES[templateName], 'npm', { version });

  return runScaffold(
    {
      dir: args.positional[0],
      template: templateName,
      name,
      force: args.flags.get('force') === true,
      json: args.flags.get('json') === true,
      depsMode: 'npm',
      effectiveTemplate,
      pinVersion: version,
      commandLabel: 'create-pyric',
    },
  );
}

const code = await main();
process.exit(code);
