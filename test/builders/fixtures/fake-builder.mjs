// A scripted builder with no model, for testing `round` end to end:
//
//   bun test/builders/harness.ts round <round> --builder test/builders/fixtures/fake-builder.mjs ...
//
// It runs where a model builder would, inside the run's sandbox, in its app
// directory, and does what the harness needs to see a builder do: reads its
// brief and docs, makes three planted requests to Google hosts (one from
// Node, one through the model channel, one from the harness browser), writes
// a valid report.json that says one must-be-refused action was allowed, and
// prints a result line shaped like `claude -p --output-format json`'s.
// Every planted request must fail, and each must appear in network.jsonl.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

function env(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`the fake builder needs ${name}`);
  return value;
}

function markdownFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') || name.endsWith('.mdx') ? [path] : [];
  });
}

async function nodeFetch() {
  try {
    await fetch('https://firestore.googleapis.com/v1/projects/demo-fake/databases/(default)/documents', { signal: AbortSignal.timeout(10_000) });
    return 'succeeded';
  } catch (error) {
    return `failed: ${error.cause?.code ?? error.code ?? error.message}`;
  }
}

/** A CONNECT through the proxy the harness set, to a host the model channel must refuse. */
function channelConnect(proxy) {
  const { hostname, port } = new URL(proxy);
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), hostname, () => socket.write('CONNECT oauth2.googleapis.com:443 HTTP/1.1\r\nHost: oauth2.googleapis.com:443\r\n\r\n'));
    let received = '';
    socket.on('data', (chunk) => { received += String(chunk); });
    socket.on('close', () => resolve(received.split('\r\n')[0] ?? ''));
    socket.on('error', (error) => resolve(`error: ${error.code}`));
    socket.setTimeout(10_000, () => socket.destroy());
  });
}

async function browserFetch(wsEndpoint) {
  const browser = await chromium.connect(wsEndpoint);
  try {
    const page = await browser.newPage();
    return await page.evaluate(() => fetch('https://firebasestorage.googleapis.com/v0/b/demo-fake.appspot.com/o').then(() => 'succeeded', (error) => `failed: ${error.message}`));
  } finally {
    await browser.close();
  }
}

const brief = JSON.parse(readFileSync(env('PYRIC_BUILDER_BRIEF_JSON'), 'utf8'));
const docs = markdownFiles(env('PYRIC_BUILDER_DOCS'));
const plants = {
  node: await nodeFetch(),
  channel: await channelConnect(env('HTTPS_PROXY')),
  browser: await browserFetch(env('PYRIC_BUILDER_BROWSER_WS')),
};
const step = (n, did, outcome) => ({ n, did: `${did}: ${outcome}`, result: outcome.startsWith('succeeded') ? 'broke' : 'worked', log: 'logs/builder.log' });

const report = {
  steps: [
    step(1, 'fetch to Cloud Firestore from Node', plants.node),
    step(2, 'CONNECT to oauth2.googleapis.com through the model channel', plants.channel),
    step(3, 'fetch to Cloud Storage from the harness browser', plants.browser),
  ],
  worked: [`read brief ${brief.id}`, `found ${docs.length} docs pages`],
  problems: [
    {
      id: 'fake-1',
      summary: 'a planted problem, so the report carries one',
      step: 1,
      docsLedMeToExpect: null,
      whatHappened: 'nothing; the fake builder plants this',
      errorText: '',
      logs: ['logs/builder.log'],
      reproHint: 'none: planted',
    },
  ],
  refusals: brief.mustBeRefused.map((line, index) => ({
    ...line,
    pyricAnswer: index === 0 ? 'planted: allowed' : line.productionAnswer,
    result: index === 0 ? 'allowed' : 'refused',
  })),
  stuck: null,
};
writeFileSync(env('PYRIC_BUILDER_REPORT'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ plants }));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 1,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
}));
