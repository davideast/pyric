import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function sourceUrl(path: string): string {
  return pathToFileURL(resolve(import.meta.dir, '../../../src', path)).href;
}

function runProbe(source: string): string {
  const result = Bun.spawnSync([process.execPath, '--eval', source], {
    cwd: resolve(import.meta.dir, '../../../../..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

test('importing the public rules barrel does not initialize the RTDB grammar', () => {
  const engineUrl = sourceUrl('rules/rtdb/expression-engine.ts');
  const rulesUrl = sourceUrl('rules/index.ts');
  const output = runProbe(`
    import { isRtdbExpressionEngineInitialized } from ${JSON.stringify(engineUrl)};
    await import(${JSON.stringify(rulesUrl)});
    console.log(isRtdbExpressionEngineInitialized());
  `);
  expect(output).toBe('false');
});

test('the first expression parse initializes the shared grammar', () => {
  const engineUrl = sourceUrl('rules/rtdb/expression-engine.ts');
  const parserUrl = sourceUrl('rules/rtdb/grammar/RtdbExprParser.ts');
  const output = runProbe(`
    import { isRtdbExpressionEngineInitialized } from ${JSON.stringify(engineUrl)};
    import { parseExpression } from ${JSON.stringify(parserUrl)};
    const before = isRtdbExpressionEngineInitialized();
    const parsed = parseExpression('auth !== null');
    console.log(JSON.stringify({ before, valid: parsed.valid, after: isRtdbExpressionEngineInitialized() }));
  `);
  expect(JSON.parse(output)).toEqual({ before: false, valid: true, after: true });
});
