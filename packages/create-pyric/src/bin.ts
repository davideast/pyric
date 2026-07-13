#!/usr/bin/env node
/**
 * `create-pyric` — `npm create pyric [dir]` / `npx create-pyric [dir]`.
 *
 * Always scaffolds with registry deps (npm). Default template is `web`
 * (Vite + `@pyric/cli/vite`).
 */

import { parseCreateArgs } from './parse-args.js';
import { applyDepsMode, normalizeBoolFlags, runScaffold, TEMPLATES } from './scaffold.js';

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

  const effectiveTemplate = applyDepsMode(TEMPLATES[templateName], 'npm', { version: null });

  return runScaffold(
    {
      dir: args.positional[0],
      template: templateName,
      name,
      force: args.flags.get('force') === true,
      json: args.flags.get('json') === true,
      depsMode: 'npm',
      effectiveTemplate,
      commandLabel: 'create-pyric',
    },
  );
}

const code = await main();
process.exit(code);
