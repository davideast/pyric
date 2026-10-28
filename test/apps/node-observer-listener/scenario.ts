// `onSnapshot` with an observer object in a server process started with
// `node --import @pyric/cli/register` against the Node host (#1358, FP-3).
// Production fires an observer exactly as it fires a bare callback
// (observation `firestore-row-84-observer-object-form`). The served client
// read the observer as listen options, so `next` never ran and each frame
// threw "callback is not a function" out of the connection's message handler:
// with no error handler the process crashed, and with one the connection
// stalled and the next write never resolved. A denied listen with no `error`
// handler is logged once, as the SDK logs it, and throws nothing.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

function line(output: string, name: string): unknown {
  const match = output.match(new RegExp(`^${name.replaceAll('.', '\\.')} (.*)$`, 'm'));
  assert.ok(match, `no ${name} line in:\n${output}`);
  return JSON.parse(match[1]!);
}

export default scenario(async (app) => {
  const host = await app.step('start the Node host', () => app.devServer());
  const env = { PYRIC_SANDBOX: `remote:${host.url}` };

  await app.step('the report: an observer with next alone sees the doc and its write, and the process exits 0', async () => {
    const { output } = await app.serverScript('plain.mjs', [], { env, timeoutMs: 40_000 });
    assert.match(output, /^plain write resolved$/m, output);
    assert.match(output, /^plain seen \[false,true\]$/m, output);
  });

  const forms = await app.step('the other observer forms run to the end', async () => {
    const { output } = await app.serverScript('forms.mjs', [], { env, timeoutMs: 90_000 });
    assert.match(output, /^forms done$/m, output);
    assert.doesNotMatch(output, /^uncaught exception/m, output);
    return output;
  });

  await app.step('a doc observer with an error handler sees the write, and the write resolves', () => {
    assert.deepEqual(line(forms, 'doc.observer'), { seen: [false, true], errors: [], write: 'resolved' }, forms);
  });

  await app.step('a query observer sees the written doc', () => {
    const query = line(forms, 'query.observer') as { last: string[]; write: string };
    assert.equal(query.write, 'resolved', forms);
    assert.ok(query.last.includes('q'), forms);
  });

  await app.step('an observer after listen options fires', () => {
    assert.deepEqual(line(forms, 'doc.optionsObserver'), { seen: [false] }, forms);
  });

  await app.step('a denied listen with no error handler is logged once and the connection still answers', () => {
    assert.deepEqual(line(forms, 'denied.nextOnly'), { reported: 1, denied: true }, forms);
    assert.equal(line(forms, 'after.write'), 'resolved', forms);
  });
});
