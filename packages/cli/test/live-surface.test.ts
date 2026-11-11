/**
 * Live mode is its own package. `pyric` and `@pyric/cli` declare no bin,
 * export, flag, config key or environment variable that turns it on: the
 * only live surfaces they hold are the three internal seams `@pyric/live`
 * calls, and each refuses to start in a project without `@pyric/live`
 * installed. `test/e2e/live-command.pw.ts` starts `pyric sandbox --hosted`
 * with every live flag, key and variable a developer might try, and finds a
 * sandbox host.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parseArgs } from '../src/cli/parse-args.js';
// Imported here, before any test changes the working directory: the serve
// modules it loads read the working directory once, as they load.
import {
  LiveProjectMissingError,
  checkLiveRunRuntime,
  discoverLiveHost,
  liveHostProject,
  probeLiveHostUrl,
  runLiveHost,
} from '../src/serve/live-host.js';
import { LIVE_PROJECT_ROOT_VARIABLE, LIVE_SDK_ROOT_VARIABLE, loadInstalledLiveRegister } from '../src/register/live-package.js';

const cliDir = fileURLToPath(new URL('../', import.meta.url));
const pyricDir = fileURLToPath(new URL('../../pyric/', import.meta.url));
const liveDir = fileURLToPath(new URL('../../live/', import.meta.url));

interface Manifest {
  bin?: string | Record<string, string>;
  exports?: Record<string, unknown>;
}

function manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
}

function binNames(pkg: Manifest): string[] {
  if (pkg.bin === undefined) return [];
  return typeof pkg.bin === 'string' ? ['(default)'] : Object.keys(pkg.bin);
}

/** The seams `@pyric/live` calls, each gated on the installed package. */
const LIVE_SEAMS = ['./vite/internal/supplied-rows', './register/internal/supplied-rows', './serve/internal/live-host'];

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const isDirectory = statSync(path).isDirectory();
    if (isDirectory) files.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry) && !entry.includes('.generated')) files.push(path);
  }
  return files;
}

/** A field name that would switch live mode on: `live`, `liveHost`, `liveStatus`; not `liveness`. */
const LIVE_FIELD = /^live($|[A-Z_])/;

/** The source file each public export of `@pyric/cli` builds from; the live seams are left out. */
function publicEntrySources(): string[] {
  const sources = new Set<string>();
  const collect = (key: string, value: unknown): void => {
    if (typeof value === 'string') {
      const isScript = value.startsWith('./dist/') && value.endsWith('.js');
      if (!isScript) return;
      const source = join(cliDir, value.replace('./dist/', 'src/').replace(/\.js$/, '.ts'));
      if (existsSync(source)) sources.add(source);
      return;
    }
    if (typeof value === 'object' && value !== null) for (const nested of Object.values(value)) collect(key, nested);
  };
  for (const [key, value] of Object.entries(manifest(cliDir).exports ?? {})) {
    if (LIVE_SEAMS.includes(key)) continue;
    collect(key, value);
  }
  return [...sources];
}

/**
 * Every field named like a live switch on a type a public export reaches:
 * its exported types, its functions' parameters and results, and the fields
 * of each, to a few levels down. Types from dependencies are not walked.
 */
function liveFieldsOnPublicTypes(): string[] {
  const entries = publicEntrySources();
  const program = ts.createProgram(entries, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const found = new Set<string>();
  const seen = new Set<ts.Type>();
  const isOwnSymbol = (symbol: ts.Symbol | undefined): boolean => {
    const file = symbol?.declarations?.[0]?.getSourceFile().fileName ?? '';
    return file.includes('/packages/cli/src/');
  };
  const visit = (type: ts.Type, where: string, depth: number): void => {
    if (depth > 5 || seen.has(type)) return;
    seen.add(type);
    if (type.isUnionOrIntersection()) {
      for (const part of type.types) visit(part, where, depth);
      return;
    }
    for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
      for (const parameter of signature.getParameters()) {
        const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
        if (declaration !== undefined) visit(checker.getTypeOfSymbolAtLocation(parameter, declaration), `${where}(${parameter.name})`, depth + 1);
      }
      visit(signature.getReturnType(), `${where}()`, depth + 1);
    }
    const ownType = isOwnSymbol(type.getSymbol() ?? type.aliasSymbol);
    if (!ownType) return;
    for (const property of type.getProperties()) {
      if (LIVE_FIELD.test(property.name)) found.add(`${where}.${property.name}`);
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (declaration !== undefined) visit(checker.getTypeOfSymbolAtLocation(property, declaration), `${where}.${property.name}`, depth + 1);
    }
  };
  for (const entry of entries) {
    const source = program.getSourceFile(entry);
    const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (declaration === undefined) continue;
      const where = `${entry.replace(cliDir, '')}:${exported.name}`;
      if (LIVE_FIELD.test(exported.name)) found.add(where);
      const isTypeOnly = (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) !== 0 && symbol.valueDeclaration === undefined;
      const type = isTypeOnly ? checker.getDeclaredTypeOfSymbol(symbol) : checker.getTypeOfSymbolAtLocation(symbol, declaration);
      visit(type, where, 0);
    }
  }
  return [...found].sort();
}

const roots: string[] = [];
const startDir = process.cwd();
afterEach(() => {
  process.chdir(startDir);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pyric and @pyric/cli expose nothing live', () => {
  it('declare no live bin', () => {
    expect(binNames(manifest(cliDir))).toEqual(['pyric']);
    for (const name of binNames(manifest(pyricDir))) expect(name).not.toMatch(/live/i);
  });

  it('export only the internal seams @pyric/live calls', () => {
    const cliLive = Object.keys(manifest(cliDir).exports ?? {}).filter((key) => /live|supplied-rows/i.test(key));
    expect(cliLive.sort()).toEqual([...LIVE_SEAMS].sort());
    const pyricLive = Object.keys(manifest(pyricDir).exports ?? {}).filter((key) => /live/i.test(key));
    expect(pyricLive).toEqual([]);
  });

  it('declare no live field on any option or type a public export reaches', () => {
    expect(liveFieldsOnPublicTypes()).toEqual([]);
  }, 120_000);

  it('parse no live flag: `--live` is an unknown flag pyric sandbox never reads', () => {
    const parsed = parseArgs(['sandbox', '--hosted', '--live']);
    expect(parsed.flags.get('live')).toBe(true);
    const sources = sourceFiles(join(cliDir, 'src'));
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/flags\.get\(['"][^'"]*live[^'"]*['"]\)/i);
    }
  });

  it('read no live config key or environment variable that turns live mode on', () => {
    const sources = [...sourceFiles(join(cliDir, 'src')), ...sourceFiles(join(pyricDir, 'src'))];
    const variables = new Set<string>();
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/PYRIC_[A-Z0-9_]*LIVE[A-Z0-9_]*/g)) variables.add(match[0]);
      expect(text, file).not.toMatch(/config\.live\b|pyricConfig\.live\b|\.live\s*===\s*true\s*\?\s*'live'/);
    }
    // Error codes, and the three variables a live process passes its own children:
    // PYRIC_LIVE_PROJECT_ROOT names where to look, PYRIC_LIVE_PASS_THROUGH
    // narrows which imports go to production, and PYRIC_LIVE_SDK_ROOT names the
    // folder whose firebase the first process checked, so a child's rows resolve
    // that copy rather than one beside its own cwd. All are read only inside
    // activateWithSuppliedRows, which only @pyric/live/register calls, so live
    // mode still starts only by importing @pyric/live/register.
    expect([...variables].sort()).toEqual([
      'PYRIC_LIVE_NO_PROJECT',
      'PYRIC_LIVE_PASS_THROUGH',
      'PYRIC_LIVE_PROJECT_ROOT',
      'PYRIC_LIVE_REFUSED',
      'PYRIC_LIVE_SDK_ROOT',
      'PYRIC_TEST_PEER_LIVENESS_MS',
    ]);
  });
});

describe('the live host seam', () => {
  it('refuses to start in a project without @pyric/live installed', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-no-live-')));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'no-live', private: true }));
    writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: 'no-live' } }));
    process.chdir(root);
    await expect(runLiveHost(['--no-open'])).rejects.toThrow('live rows need @pyric/live installed in the project');
    await expect(probeLiveHostUrl('http://localhost:3473', root)).rejects.toThrow(
      'live rows need @pyric/live installed in the project',
    );
    await expect(discoverLiveHost(root)).rejects.toThrow('live rows need @pyric/live installed in the project');
    expect(() => checkLiveRunRuntime(['node', 'a.js'], root)).toThrow(
      'live rows need @pyric/live installed in the project',
    );
  });

  it('refuses non-loopback URLs before probing or reading local tokens', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-non-loopback-')));
    roots.push(root);
    await expect(probeLiveHostUrl('http://example.com:3473', root, { liveRoot: liveDir })).rejects.toThrow(
      'loopback origins',
    );
  });

  it('names the project the app\'s Firebase config sets, and refuses to start without one', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-project-')));
    roots.push(root);
    expect(() => liveHostProject([], root)).toThrow(LiveProjectMissingError);
    expect(() => liveHostProject([], root)).toThrow('Set one with `firebase use <project-id>`, or name it in .firebaserc');
    writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: 'from-rc' } }));
    expect(liveHostProject([], root)).toBe('from-rc');
    expect(liveHostProject(['--project', 'from-flag'], root)).toBe('from-flag');
  });
});

describe('the folder the live register rows resolve firebase from', () => {
  /** A project with firebase installed in web/ and, at another version, in functions/. */
  function twoInstalls(): { root: string; web: string; functions: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-sdk-root-')));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', private: true }));
    for (const [folder, version] of [['web', '12.12.0'], ['functions', '11.10.0']]) {
      const firebase = join(root, folder, 'node_modules', 'firebase');
      mkdirSync(firebase, { recursive: true });
      writeFileSync(join(firebase, 'package.json'), JSON.stringify({ name: 'firebase', version }));
    }
    return { root, web: join(root, 'web'), functions: join(root, 'functions') };
  }

  it('is the folder the first process runs in, when firebase resolves there', async () => {
    const { root, web } = twoInstalls();
    const installed = await loadInstalledLiveRegister(root, liveDir, web, {});
    expect(installed.sdkRoot).toBe(web);
    expect(installed.rows.projectUrl).toBe(pathToFileURL(join(web, 'package.json')).href);
  });

  it('in a child, is the folder its first process recorded, not the child\'s cwd with its own firebase', async () => {
    const { root, web, functions } = twoInstalls();
    const childEnv = { [LIVE_PROJECT_ROOT_VARIABLE]: root, [LIVE_SDK_ROOT_VARIABLE]: web };
    const installed = await loadInstalledLiveRegister(root, liveDir, functions, childEnv);
    expect(installed.sdkRoot).toBe(web);
    expect(installed.rows.projectUrl).toBe(pathToFileURL(join(web, 'package.json')).href);
  });

  it('ignores a recorded folder without a recorded project root, which only a child has', async () => {
    const { root, web, functions } = twoInstalls();
    const installed = await loadInstalledLiveRegister(root, liveDir, functions, { [LIVE_SDK_ROOT_VARIABLE]: web });
    expect(installed.sdkRoot).toBe(functions);
  });
});
