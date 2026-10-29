import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';

import { DEFAULT_MCP_TOOL_NAMES } from '../src/bridge/server/mcp-contract.js';
import { TOOLS } from '../src/bridge/surface/methods/registry.js';

interface ReleaseContract {
  schema: 'pyric.cli.release-contract.v1';
  commands: string[];
  derivedCommands: string[];
  exports: string[];
  removedExports: string[];
  mcpTools: string[];
  mcpToolMethods: Record<string, string[]>;
  allowedFirebaseSdkImportEdges: string[];
}

const workspaceRoot = join(import.meta.dir, '../../..');
const packageRoot = join(workspaceRoot, 'packages/cli');
const cliEntry = join(packageRoot, 'src/cli/index.ts');
const contract = JSON.parse(
  readFileSync(join(workspaceRoot, 'scripts/fixtures/cli-release-contract.json'), 'utf8'),
) as ReleaseContract;
const manifest = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8'),
) as { exports: Record<string, unknown> };

function isFirebaseSdk(specifier: string): boolean {
  return /^(firebase|firebase-admin)(\/|$)/.test(specifier);
}

/** Real (non-type-only) Firebase SDK imports in one source file. */
function firebaseSdkImports(file: string): string[] {
  const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isFirebaseSdk(node.moduleSpecifier.text)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/** The packed dist edges the source implies: src/<path>.ts -> dist/<path>.js. */
function sourceFirebaseSdkEdges(): string[] {
  const srcRoot = join(packageRoot, 'src');
  return (readdirSync(srcRoot, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .flatMap((file) =>
      firebaseSdkImports(join(srcRoot, file)).map(
        (specifier) => `dist/${file.slice(0, -'.ts'.length)}.js -> ${specifier}`,
      ),
    );
}

function advertisedCommands(help: string): string[] {
  const section = help.split('\nCOMMANDS\n')[1]?.split('\nCORE FLAGS')[0];
  if (section === undefined) throw new Error('pyric help has no COMMANDS section');
  return section
    .split('\n')
    .filter((line) => /^  \S/.test(line))
    .map((line) => line.trim().split(/\s{2,}|\s+(?=[A-Z])/, 1)[0]!)
    .map((cell) => cell.replace(/\s+(?:\[|<).*$/, ''));
}

/**
 * The help text advertises the whole derived family on one row, because a
 * thirty-seven-row help section is not a help section. The rows themselves are
 * pinned in the contract instead, one per `pyric <tool> <method>`.
 */
const DERIVED_COMMAND_ROW = '<tool>';

describe('ratified @pyric/cli release contract', () => {
  it('pins every advertised command exactly', () => {
    const result = spawnSync('bun', [cliEntry, '--help'], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const advertised = advertisedCommands(result.stdout);
    expect(advertised).toContain(DERIVED_COMMAND_ROW);
    const explicit = advertised.filter((command) => command !== DERIVED_COMMAND_ROW);
    expect(explicit.sort()).toEqual([...contract.commands].sort());
  });

  it('pins every derived `pyric <tool> <method>` command exactly', () => {
    const derived = TOOLS.flatMap((tool) =>
      tool.methods.map((method) => `${tool.name} ${method.method}`),
    ).sort();
    expect(derived).toEqual([...contract.derivedCommands].sort());
    expect(contract.derivedCommands).toEqual([...contract.derivedCommands].sort());
    expect(contract.commands).not.toContain(DERIVED_COMMAND_ROW);
  });

  it('pins every retained and intentionally removed package export exactly', () => {
    const actual = Object.keys(manifest.exports);
    expect(actual.sort()).toEqual([...contract.exports].sort());
    for (const removed of contract.removedExports) expect(actual).not.toContain(removed);
  });

  it('pins the ratified exactly-ten-tool MCP inventory and every method it carries', () => {
    expect(contract.mcpTools).toHaveLength(10);
    expect([...DEFAULT_MCP_TOOL_NAMES].sort()).toEqual([...contract.mcpTools].sort());
    const actualMethods: Record<string, string[]> = {};
    for (const tool of TOOLS) {
      actualMethods[tool.name] = tool.methods.map((method) => method.method).sort();
    }
    const pinnedMethods: Record<string, string[]> = {};
    for (const [tool, methods] of Object.entries(contract.mcpToolMethods)) {
      pinnedMethods[tool] = [...methods].sort();
    }
    expect(actualMethods).toEqual(pinnedMethods);
  });

  it('pins the packed Firebase SDK import edges to the ones the source declares', () => {
    // The packaging gate audits the packed tarball against these rows and only
    // runs on main or when packaging files change. A source change that adds,
    // removes or moves a Firebase SDK import fails here on its own pull
    // request instead (#1293 moved one and broke main).
    expect(sourceFirebaseSdkEdges().sort()).toEqual([...contract.allowedFirebaseSdkImportEdges].sort());
  });
});
