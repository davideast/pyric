/**
 * The derivation invariant: the MCP tool descriptions and the CLI command
 * registry are both generated from the method records, in one run, and both
 * match what is in the tree.
 *
 * One declaration derives every surface. A record edited without regenerating,
 * or a generated file edited by hand, fails here rather than shipping two
 * surfaces that disagree.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  renderServiceCommandRegistry,
  surfaceCommandSources,
} from '../../../scripts/generate-service-command-registry.js';
import { renderDescriptionModule } from '../../../src/bridge/surface/generate-descriptions.js';
import {
  renderSurfaceManifest,
  surfaceSources,
} from '../../../src/bridge/surface/generate-manifest.js';
import { METHODS, TOOLS } from '../../../src/bridge/surface/methods/registry.js';
import { renderToolDescriptions } from '../../../src/bridge/surface/tool-description.js';
import { SANDBOX_METHOD_WORDS } from '../../../src/cli/parse-args.js';
import { SERVICE_COMMANDS } from '../../../src/cli/service-commands.generated.js';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..', '..');
const SURFACE_DIRECTORY = join(PACKAGE_ROOT, 'src', 'bridge', 'surface');

/** Everything the build derives from the records, rendered in one pass. */
function regenerate(): { manifest: string; descriptions: string; commands: string } {
  const sources = surfaceSources(readdirSync(join(SURFACE_DIRECTORY, 'tools')), (tool) =>
    readdirSync(join(SURFACE_DIRECTORY, 'methods', tool)),
  );
  const commandRecords = readdirSync(join(PACKAGE_ROOT, 'src', 'cli', 'service-command-records'))
    .filter((file) => file.endsWith('.ts'));
  return {
    manifest: renderSurfaceManifest(sources),
    descriptions: renderDescriptionModule(renderToolDescriptions(TOOLS)),
    commands: renderServiceCommandRegistry(commandRecords, surfaceCommandSources(sources)),
  };
}

describe('one declaration derives every surface', () => {
  const rendered = regenerate();

  it('regenerates the record manifest to what is in the tree', () => {
    expect(rendered.manifest).toBe(
      readFileSync(join(SURFACE_DIRECTORY, 'manifest.generated.ts'), 'utf8'),
    );
  });

  it('regenerates the MCP tool descriptions to what is in the tree', () => {
    expect(rendered.descriptions).toBe(
      readFileSync(join(SURFACE_DIRECTORY, 'descriptions.generated.ts'), 'utf8'),
    );
  });

  it('regenerates the CLI command registry to what is in the tree', () => {
    expect(rendered.commands).toBe(
      readFileSync(join(PACKAGE_ROOT, 'src', 'cli', 'service-commands.generated.ts'), 'utf8'),
    );
  });

  it('keeps the parser\'s sandbox method words in step with the records', () => {
    const sandboxMethods = TOOLS.find((tool) => tool.name === 'sandbox')!.methods;
    expect([...SANDBOX_METHOD_WORDS].sort()).toEqual(
      sandboxMethods.map((method) => method.method).sort(),
    );
  });

  it('gives every record a `pyric <tool> <method>` command', () => {
    const routes = new Set(
      SERVICE_COMMANDS.map((command) => (command.path as readonly string[]).join(' ')),
    );
    for (const method of METHODS) {
      expect(routes.has(`${method.tool} ${method.method}`)).toBe(true);
    }
  });
});
