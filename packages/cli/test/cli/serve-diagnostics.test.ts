import { expect, test } from 'bun:test';
import { runServeDiagnostics } from '../../src/cli/serve-diagnostics.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { closedPort } from '../closed-port.js';

test('diagnostics CLI reports HTTP failure as structured JSON without leaking URL secrets', async () => {
  let output = '';
  const port = await closedPort();
  const code = await runServeDiagnostics(parseArgs(['serve', 'diagnostics', '--url', `http://127.0.0.1:${port}/?token=secret`, '--json']), {
    stdout: { write: value => { output += value; } },
  });
  expect(code).toBe(2);
  const result = JSON.parse(output);
  expect(result.server.http).toBe('unreachable');
  expect(output).not.toContain('secret');
});
