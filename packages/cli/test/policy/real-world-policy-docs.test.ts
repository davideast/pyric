import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import * as policyModule from '../../../rules/dist/policy/index.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const DOC_PATH = join(REPO_ROOT, 'packages/site-docs/src/content/build/policy-extension.md');
const POLICY_ENTRY_URL = pathToFileURL(
  join(REPO_ROOT, 'packages/rules/dist/policy/index.js'),
).href;
const DIAGNOSTICS_SRC_PATH = join(REPO_ROOT, 'packages/rules/src/policy/diagnostics.ts');

interface FenceBlock {
  lang: string;
  source: string;
}

function extractFences(markdown: string): FenceBlock[] {
  const out: FenceBlock[] = [];
  let open: { lang: string; lines: string[] } | null = null;
  for (const line of markdown.split('\n')) {
    if (open === null) {
      const m = /^```([A-Za-z0-9_-]*)\s*$/.exec(line);
      if (m) open = { lang: m[1]!.toLowerCase(), lines: [] };
      continue;
    }
    if (/^```\s*$/.test(line)) {
      out.push({ lang: open.lang, source: open.lines.join('\n') });
      open = null;
      continue;
    }
    open.lines.push(line);
  }
  return out;
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('policy-extension.md reference guide verification', () => {
  const markdown = readFileSync(DOC_PATH, 'utf8');

  test('satisfies frontmatter, line limit, 7-bit ASCII, and relative link checks', () => {
    const lines = markdown.split('\n');
    expect(lines.length - 1).toBeLessThanOrEqual(600);
    for (let i = 0; i < markdown.length; i++) {
      expect(markdown.charCodeAt(i), `non-ASCII at offset ${i}`).toBeLessThanOrEqual(127);
    }

    expect(markdown).toMatch(/^---\n[\s\S]*?\n---\n/);
    expect(markdown).toContain('group: "Build"');
    expect(markdown).toMatch(/^order:\s+\d+$/m);
    expect(markdown).toContain('navLabel: "Policy extension"');

    // Every relative markdown link points to a real file in the site docs.
    const linkRe = /\]\(([^)#]+)(?:#[^)]+)?\)/g;
    let m: RegExpExecArray | null;
    const checked: string[] = [];
    while ((m = linkRe.exec(markdown)) !== null) {
      const target = m[1]!;
      if (/^https?:\/\//.test(target)) continue;
      const resolved = resolve(dirname(DOC_PATH), target);
      expect(existsSync(resolved), `broken doc link: ${target}`).toBe(true);
      checked.push(target);
    }
    expect(checked.length).toBeGreaterThanOrEqual(6);

    // Every documented PlacementReasonCode matches diagnostics.ts verbatim.
    const diagSrc = readFileSync(DIAGNOSTICS_SRC_PATH, 'utf8');
    const unionMatch = /export type PlacementReasonCode =([\s\S]*?);/.exec(diagSrc);
    expect(unionMatch).not.toBeNull();
    const codes = [...unionMatch![1]!.matchAll(/'([A-Z_]+)'/g)].map((hit) => hit[1]!);
    expect(codes.length).toBeGreaterThanOrEqual(10);
    for (const code of codes) {
      expect(markdown, `missing PlacementReasonCode ${code}`).toContain(`\`${code}\``);
    }
  });

  test('compiles every rules fence and executes every TypeScript snippet against real exports', async () => {
    const fences = extractFences(markdown);
    const rulesFences = fences.filter((f) => f.lang === 'rules');
    const tsFences = fences.filter((f) => f.lang === 'ts');
    expect(rulesFences.length).toBeGreaterThanOrEqual(1);
    expect(tsFences.length).toBe(4);

    for (const rf of rulesFences) {
      const compiled = policyModule.compilePolicy(rf.source);
      expect(compiled.standaloneModule().exports).toContain('judge');
      const proof = policyModule.provePolicy(rf.source, { fuzz: { seed: 7, cases: 20 } });
      expect(proof.ok).toBe(true);
    }

    const exportedNames = new Set(Object.keys(policyModule));
    for (let i = 0; i < tsFences.length; i++) {
      const source = tsFences[i]!.source;
      expect(source).not.toContain('data:text/javascript');

      const sf = ts.createSourceFile(`doc-${i}.ts`, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
      for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        if (stmt.moduleSpecifier.text !== '@pyric/rules/experimental/policy') continue;
        const bindings = stmt.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            if (el.isTypeOnly) continue;
            const name = (el.propertyName ?? el.name).text;
            expect(exportedNames.has(name), `unknown export in doc snippet ${i}: ${name}`).toBe(true);
          }
        }
      }

      const dir = mkdtempSync(join(tmpdir(), `pyric-policy-doc-test-${i}-`));
      tempDirs.push(dir);
      const runner = join(dir, `snippet-${i}.ts`);
      const rewritten = source.replaceAll(
        "'@pyric/rules/experimental/policy'",
        `'${POLICY_ENTRY_URL}'`,
      );
      writeFileSync(runner, rewritten, 'utf8');
      await import(pathToFileURL(runner).href);
    }
  });
});
