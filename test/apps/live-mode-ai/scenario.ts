/**
 * Live mode observes the app's own Firebase AI Logic calls, through the
 * packed packages: the assistant app's page on `vite dev` with `pyricLive()`,
 * and the same client code as its server job under
 * `node --import @pyric/live/register`. Each makes an app with no App Check
 * and one with a token (a CustomProvider on the page, a server app's
 * `appCheckToken` in Node), both signed in. The chip's Traffic shows each
 * call as production's, from the client that made it: the call with no App
 * Check failed `unauthenticated`, as production answers a project that
 * enforces App Check; generateContent, generateContentStream, countTokens and
 * a chat's sendMessage and sendMessageStream ok, with production's token
 * counts; a model no one serves failed `not_found`. No row records the
 * response, the host's event stream carries no prompt or envelope text, and
 * AI calls add nothing to the billed count. `getLiveGenerativeModel` throws
 * live mode's refusal and nothing reaches the replay for it.
 *
 * Production is a replay server this scenario starts (`../replay/`), playing
 * custom-token sign-ins and answering AI Logic from the committed
 * observations (`--ai`). Its answers are not consumed, so one server answers
 * both planes. The app reaches Auth with the SDK's emulator connector and AI
 * Logic with the model's `baseUrl` (`?backend=` on the page, `APP_BACKEND`
 * for the server job). Like every app scenario this runs offline, and the
 * browser blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright';
import { scenario, sleep, type App } from '../driver.ts';

const PROJECT = 'demo-live-ai';
const MODEL = 'gemini-flash-lite-latest';
const UNSERVED_MODEL = 'gemini-not-served';
const SIGN_INS = 'sign-ins.json';
const BILLED_NONE = { reads: 0, writes: 0, deliveries: 0 };
/** How long one run of the app's calls may take, on the page or in the server job: well under the runner's 300 s. */
const APP_RUN_MS = 60_000;
/** What the host's event stream must never carry: the prompts' shared word and parts of production's envelopes. */
const ENVELOPE_TEXT = ['lighthouse', 'thoughtSignature', 'candidates', '2 3 4 5 6 7 8 9 10', '-4Xkar3AM_S6jrEPh-_duQ8', '_IXkat2IHNGsjrEPtsCTGA'];

declare function runApp(): Promise<unknown>;
declare function openLive(): string;

interface AiReceived {
  rpc: string;
  message: { project: string; model: string; task: string; appCheck: boolean };
}

interface Replay {
  origin: string;
  /** The AI Logic calls the replay answered, in arrival order. */
  aiReceived(): Promise<AiReceived['message'][]>;
  unmatched(): Promise<unknown[]>;
  stop(): Promise<void>;
}

/** Custom-token sign-ins: `client-1` gets an anonymous ID token for `user-1`. */
function signIns(format: string): Record<string, unknown> {
  const uid = 'user-1';
  const exchanges = [{
    kind: 'auth',
    id: 'sign-in-1',
    request: { method: 'POST', host: 'identitytoolkit.googleapis.com', path: '/v1/accounts:signInWithCustomToken', body: { token: 'client-1', returnSecureToken: true } },
    response: { status: 200, body: { kind: 'identitytoolkit#VerifyCustomTokenResponse', idToken: { $: 'idToken', uid, provider: 'anonymous' }, refreshToken: { $: 'refreshToken' }, expiresIn: '3600', isNewUser: true } },
  }, {
    kind: 'auth',
    id: 'lookup-1',
    request: { method: 'POST', host: 'identitytoolkit.googleapis.com', path: '/v1/accounts:lookup', body: { idToken: { $: 'idToken', uid } } },
    response: { status: 200, body: { kind: 'identitytoolkit#GetAccountInfoResponse', users: [{ localId: uid, lastLoginAt: '1793990000000', createdAt: '1793990000000' }] } },
  }];
  return { format, project: PROJECT, source: 'hand-written from the Auth REST v1 wire format', exchanges };
}

/** The project's files a user's checkout has: `.firebaserc` names it, and the sign-ins recording the replay plays. */
async function writeProject(app: App): Promise<void> {
  const { FORMAT } = await import('../replay/format.ts');
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  app.writeFile('firebase.json', `${JSON.stringify({ hosting: { public: 'public' } })}\n`);
  app.writeFile(SIGN_INS, `${JSON.stringify(signIns(FORMAT))}\n`);
}

async function startReplay(app: App): Promise<Replay> {
  const { replayServerArgs, endpointsIn, receivedBy, unmatchedBy } = await import('../replay/process.ts');
  const server = app.commandProcess('node', replayServerArgs([`${app.dir}/${SIGN_INS}`], undefined, { ai: true }));
  await server.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(server.output);
  assert.ok(endpoints, `the replay server named no origin:\n${server.output}`);
  return {
    origin: endpoints.origin,
    aiReceived: async () => ((await receivedBy(endpoints.origin)) as AiReceived[]).filter((entry) => entry.rpc === 'ai').map((entry) => entry.message),
    unmatched: () => unmatchedBy(endpoints.origin),
    stop: () => server.stop(),
  };
}

/** Fails with `what` when `run` has not settled within `ms`. */
async function within<T>(what: string, ms: number, run: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** What the app's calls return, as production answered them. */
function expectedResults(): Record<string, unknown> {
  const counted = '1 2 3 4 5 6 7 8 9 10';
  return {
    noAppCheck: 'http 401',
    generateContent: { text: 'pyric', totalTokenCount: 11 },
    generateContentStream: counted,
    countTokens: 11,
    sendMessage: 'pyric',
    sendMessageStream: counted,
    unknownModel: 'http 404',
  };
}

/** The AI Logic calls one plane's run sends production, in order: the chat's turns are generate and stream calls on the wire. */
function expectedAiCalls(): AiReceived['message'][] {
  const call = (task: string, appCheck = true, model = MODEL) => ({ project: PROJECT, model, task, appCheck });
  return [
    call('generateContent', false),
    call('generateContent'),
    call('streamGenerateContent'),
    call('countTokens'),
    call('generateContent'),
    call('streamGenerateContent'),
    call('generateContent', true, UNSERVED_MODEL),
  ];
}

function resultOf(output: string): Record<string, unknown> {
  const line = output.split('\n').find((entry) => entry.startsWith('RESULT '));
  assert.ok(line, `no RESULT line:\n${output}`);
  return JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown>;
}

/** Polls `read` until `check` passes, failing with the last value after `timeoutMs`. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(value, null, 1)} after ${timeoutMs / 1000}s`);
    await sleep(250);
  }
}

/** The chip, opened. */
async function openChip(page: Page): Promise<Locator> {
  const chip = page.locator('[data-pyric-runtime-chip-host]');
  await chip.waitFor({ state: 'attached', timeout: 30_000 });
  if (!await chip.locator('[data-chip-tab=traffic]').isVisible()) await chip.locator('[data-expand]').click();
  return chip;
}

interface BilledCount {
  reads: number;
  writes: number;
  deliveries: number;
}

/** The host's billed-call count, as its health report carries it. */
async function billed(url: string): Promise<BilledCount | undefined> {
  const health = await (await fetch(`${url}/__pyric/health`)).json() as { live?: { billed?: BilledCount } };
  return health.live?.billed;
}

interface Row {
  id: string;
  /** `<served> <source> <call> <requested and routed model> <answer> <account>`. */
  text: string;
}

/** Every AI row Traffic lists in `scope`, picking the AI filter afresh so the list follows new rows. */
async function aiRows(chip: Locator, scope: 'page' | 'all'): Promise<Row[]> {
  await chip.locator('[data-chip-tab=traffic]').click();
  // On a live host the scope is the From select: this page's requests, or every client's.
  await chip.locator('[data-traffic-from]').selectOption(scope);
  const service = chip.locator('[data-request-service]');
  await service.selectOption('');
  await service.selectOption('ai');
  const older = chip.locator('[data-request-older]');
  while (await older.count() > 0) await older.click();
  return chip.locator('[data-traffic-rows] [data-request-row]').evaluateAll((elements) => elements.map((element) => ({
    id: element.getAttribute('data-request-row') ?? '',
    text: [
      element.querySelector('[data-traffic-row-production]') ? 'production' : 'sandbox',
      element.querySelector('[data-traffic-row-source]')?.getAttribute('data-traffic-row-source') ?? '-',
      (element.querySelector('.c1')?.textContent ?? '').split(' · ').at(-1),
      [...element.querySelectorAll('.c2 .ai-model-pair span')].map((span) => span.textContent).join(' '),
      element.querySelector('[data-verdict-production]')?.getAttribute('title') ?? '-',
      element.querySelector('.s2')?.textContent ?? '',
    ].join(' '),
  })));
}

const PRODUCTION_ROUTE = 'Routed to Not reported';

/**
 * The rows one plane's run makes, one per call, sorted. This page's own rows
 * carry no source label in its scope (`-`); the server job's read `node`.
 */
function expectedRows(source: 'page' | 'node'): string[] {
  const shown = source === 'page' ? '-' : 'node';
  const row = (call: string, answer: 'succeeded' | 'failed', model = MODEL) => `production ${shown} ai.${call} Requested ${model} ${PRODUCTION_ROUTE} Production ${answer} user-1`;
  return [
    row('generateContent', 'failed'),
    row('generateContent', 'succeeded'),
    row('generateContentStream', 'succeeded'),
    row('countTokens', 'succeeded'),
    row('chat.sendMessage', 'succeeded'),
    row('chat.sendMessageStream', 'succeeded'),
    row('generateContent', 'failed', UNSERVED_MODEL),
  ].sort();
}

/** A row's detail as `<outcome> | <token facts> | <response note>`. */
async function detailOf(chip: Locator, id: string): Promise<string> {
  await chip.locator(`[data-traffic-rows] [data-request-row="${id}"]`).click();
  const detail = chip.locator('[data-traffic-detail]');
  await detail.waitFor({ state: 'visible', timeout: 10_000 });
  const text = await detail.evaluate((element) => {
    const facts = new Map([...element.querySelectorAll('.request-fact')].map((fact) => [fact.querySelector('dt')?.textContent ?? '', fact.querySelector('dd')?.textContent ?? '']));
    const tokens = ['Input tokens', 'Output tokens', 'Counted tokens'].filter((label) => facts.has(label)).map((label) => `${label} ${facts.get(label)}`);
    const note = element.querySelector('[data-request-response] .rules-privacy')?.textContent ?? '';
    return `${facts.get('Outcome') ?? ''} | ${tokens.join(', ')} | ${note}`;
  });
  await chip.locator('[data-request-back]').click();
  return text;
}

/** What each row's detail reads, by its row text: production's answer and token counts, and no recorded response. */
function expectedDetail(row: string): string {
  const notRecorded = 'Response content was not recorded for this request.';
  const failed = 'No successful response was returned.';
  const call = row.split(' ')[2];
  if (row.includes(`Requested ${UNSERVED_MODEL} `)) return `Failed in production (not_found) | Input tokens Not reported, Output tokens Not reported | ${failed}`;
  if (row.includes(' Production failed ')) return `Failed in production (unauthenticated) | Input tokens Not reported, Output tokens Not reported | ${failed}`;
  if (call === 'ai.countTokens') return `Succeeded in production | Counted tokens 11 | ${notRecorded}`;
  // A stream's counts are its last chunk's: production counts the whole stream there.
  if (call?.endsWith('Stream')) return `Succeeded in production | Input tokens 15, Output tokens 20 | ${notRecorded}`;
  return `Succeeded in production | Input tokens 9, Output tokens 2 | ${notRecorded}`;
}

/**
 * The chip shows each of one plane's calls once, as production's, and each
 * detail reads production's counts: the page's in This page, which lists
 * nothing else, and the server job's in the All view, from `node`.
 */
async function expectRows(chip: Locator, source: 'page' | 'node'): Promise<void> {
  const expected = expectedRows(source);
  const scope = source === 'page' ? 'page' : 'all';
  const fromSource = (rows: Row[]) => (source === 'page' ? rows : rows.filter((row) => row.text.split(' ')[1] === source));
  const texts = (rows: Row[]) => fromSource(rows).map((row) => row.text).sort();
  const rows = await eventually(() => aiRows(chip, scope), (all) => JSON.stringify(texts(all)) === JSON.stringify(expected), `the AI rows from ${source}`);
  const details: string[] = [];
  const wanted: string[] = [];
  for (const row of fromSource(rows)) {
    details.push(`${row.text}: ${await detailOf(chip, row.id)}`);
    wanted.push(`${row.text}: ${expectedDetail(row.text)}`);
  }
  assert.equal(details.length, expected.length, `a detail for each of the ${expected.length} rows`);
  assert.deepEqual(details.sort(), wanted.sort());
}

interface CapturedEvent { kind?: string; service?: string }

/** The host's session capture as written, and its AI operations. */
function sessionCapture(app: App): { text: string; aiEvents: CapturedEvent[] } {
  try {
    const text = app.readFile('.pyric/last-session.json');
    const capture = JSON.parse(text) as { events?: CapturedEvent[] };
    return { text, aiEvents: (capture.events ?? []).filter((event) => event.kind === 'operation' && event.service === 'ai') };
  } catch {
    return { text: '', aiEvents: [] };
  }
}

/** The host's event stream carries `count` AI operations and none of the prompts' or envelopes' text. */
async function expectNoEnvelopeText(app: App, count: number): Promise<void> {
  const capture = await eventually(async () => sessionCapture(app), (read) => read.aiEvents.length >= count, `${count} AI events on the host`);
  assert.equal(capture.aiEvents.length, count, `one AI event per call:\n${JSON.stringify(capture.aiEvents, null, 1)}`);
  assert.deepEqual(ENVELOPE_TEXT.filter((text) => capture.text.includes(text)), [], 'the event stream carries no prompt or envelope text');
}

function blockedLines(app: App): string[] {
  return app.browserLog.filter((line) => line.includes('[blocked external'));
}

export default scenario(async (app) => {
  await writeProject(app);
  const replay = await app.step('start the replay server that answers AI Logic from the observations and plays the sign-ins', () => startReplay(app));

  const host = await app.step('start vite dev with pyricLive(): the dev server is the live host', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`));
    return started;
  });

  const { page, chip } = await app.step('the page loads its client code, and the chip opens on the live project with nothing billed', async () => {
    const opened = await app.page(`${host.url}/?backend=${encodeURIComponent(replay.origin)}`);
    await opened.waitForFunction(() => document.querySelector('#status')?.textContent !== 'Starting', undefined, { timeout: 30_000 });
    const status = await opened.evaluate(() => document.querySelector('#status')?.textContent ?? '');
    assert.equal(status, 'Ready', `the page's client code did not load\nconsole:\n${app.browserLog.join('\n')}`);
    const openedChip = await openChip(opened);
    await openedChip.locator('.panel-header [data-chip-live]').waitFor({ timeout: 20_000 });
    const health = await (await fetch(`${host.url}/__pyric/health`)).json() as { live?: { projectId?: string } };
    assert.equal(health.live?.projectId, PROJECT);
    assert.deepEqual(await billed(host.url), BILLED_NONE);
    return { page: opened, chip: openedChip };
  });

  await app.step('the page makes its AI Logic calls, and production answers each one', async () => {
    assert.deepEqual(await within('the page\'s app run', APP_RUN_MS, page.evaluate(() => runApp())), expectedResults());
    assert.deepEqual(await replay.aiReceived(), expectedAiCalls());
    assert.deepEqual(await replay.unmatched(), []);
  });

  await app.step('getLiveGenerativeModel on the page throws live mode\'s refusal, and nothing reaches the replay for it', async () => {
    assert.equal(await page.evaluate(() => openLive()), 'PYRIC_LIVE_REFUSED');
    assert.deepEqual(await replay.aiReceived(), expectedAiCalls());
    assert.deepEqual(await replay.unmatched(), []);
  });

  await app.step('the chip shows each page call from This page as production\'s, with its answer and token counts', async () => {
    await expectRows(chip, 'page');
  });

  await app.step('the host\'s event stream carries no prompt or envelope text, and AI calls add nothing to the billed count', async () => {
    await expectNoEnvelopeText(app, expectedAiCalls().length);
    assert.deepEqual(await billed(host.url), BILLED_NONE);
  });

  await app.step('the server job under @pyric/live/register makes the same calls, reporting to the dev server', async () => {
    const run = await app.command('node', ['--import', '@pyric/live/register', 'client.js'], { env: { APP_BACKEND: replay.origin }, timeoutMs: APP_RUN_MS });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(`@pyric/live/register: live mode for the Firebase project ${PROJECT}\\.`));
    assert.match(run.output, /@pyric\/live\/register: reporting calls to the live host at /);
    assert.doesNotMatch(run.output, /net-guard BLOCK/);
    assert.deepEqual(resultOf(run.output), { ...expectedResults(), getLiveGenerativeModel: 'PYRIC_LIVE_REFUSED' });
    assert.deepEqual(await replay.aiReceived(), [...expectedAiCalls(), ...expectedAiCalls()]);
    assert.deepEqual(await replay.unmatched(), []);
  });

  await app.step('the chip shows each server job call as production\'s, from a Node process', async () => {
    await expectRows(chip, 'node');
    const sources = await chip.locator('[data-traffic-rows] [data-traffic-row-source]').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-traffic-row-source')));
    assert.deepEqual([...new Set(sources)].sort(), ['node', 'page'], 'the All view marks the page\'s rows and the server job\'s');
    await expectNoEnvelopeText(app, 2 * expectedAiCalls().length);
    assert.deepEqual(await billed(host.url), BILLED_NONE);
  });

  await app.step('nothing reached any host but loopback', async () => {
    assert.deepEqual(blockedLines(app), []);
    await page.close();
    await host.process.stop();
    await replay.stop();
  });
});
