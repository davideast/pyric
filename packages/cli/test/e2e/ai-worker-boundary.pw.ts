import { expect, test } from '@playwright/test';

test('served AI uses only the SharedWorker broker and emits one authoritative event', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent !== 'loading');

  const actual = await page.evaluate(async () => {
    const events: Array<{ service?: string; op?: string }> = [];
    const generation = localStorage.getItem('pyric:worker-generation');
    const worker = new SharedWorker('/__pyric/sdk/worker.js', {
      type: 'classic',
      name: generation ? `pyric-shared-worker:${generation}` : 'pyric-shared-worker',
    });
    worker.port.start();
    let notify: (() => void) | undefined;
    worker.port.onmessage = (message) => {
      if (message.data?.t !== 'event' || message.data.subId !== 'ai-boundary') return;
      events.push(...message.data.events);
      notify?.();
      notify = undefined;
    };
    worker.port.postMessage({ t: 'sub', subId: 'ai-boundary', target: 'events' });
    await new Promise<void>((resolve) => { notify = resolve; });

    const appModule = await import('firebase/app');
    const aiModule = await import('firebase/ai');
    const appCheckModule = await import('firebase/app-check');
    // AI Logic requires App Check before getAI, and so does the sandbox.
    appCheckModule.initializeAppCheck(appModule.getApp(), {
      provider: new appCheckModule.ReCaptchaV3Provider('site-key'),
    });
    const ai = aiModule.getAI(appModule.getApp());
    const repeatedAi = aiModule.getAI(appModule.getApp(), {
      engine: { kind: 'scripted', script: [] },
    });
    const target = Object.getOwnPropertySymbols(ai)
      .map((symbol) => (ai as unknown as Record<PropertyKey, unknown>)[symbol])
      .find((value) => value && typeof value === 'object' && 'kind' in value) as
        | Record<string, unknown>
        | undefined;
    const baseline = events.filter(
      (event) => event.service === 'ai' && event.op === 'count_tokens',
    ).length;

    await aiModule.getGenerativeModel(ai, { model: 'gemini-2.5-flash' })
      .countTokens('one worker event');
    const deadline = Date.now() + 5_000;
    while (
      events.filter((event) => event.service === 'ai' && event.op === 'count_tokens').length
        <= baseline
      && Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => {
        notify = resolve;
        setTimeout(resolve, 25);
      });
    }

    worker.port.postMessage({ t: 'unsub', subId: 'ai-boundary' });
    worker.port.close();
    return {
      targetKind: target?.kind,
      stableHandle: repeatedAi === ai,
      hasPageBroker: target ? 'broker' in target : null,
      hasPageSandbox: target ? 'sandbox' in target : null,
      workerEvents: events.filter(
        (event) => event.service === 'ai' && event.op === 'count_tokens',
      ).length - baseline,
    };
  });

  expect(actual).toEqual({
    targetKind: 'transport',
    stableHandle: true,
    hasPageBroker: false,
    hasPageSandbox: false,
    workerEvents: 1,
  });
});

test('the SharedWorker broker refuses AI requests from an app without App Check, as AI Logic does', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent !== 'loading');

  const refusal = await page.evaluate(async () => {
    const appModule = await import('firebase/app');
    const aiModule = await import('firebase/ai');
    const app = appModule.initializeApp({ ...appModule.getApp().options }, 'no-app-check');
    const model = aiModule.getGenerativeModel(aiModule.getAI(app), { model: 'gemini-2.5-flash' });
    try {
      await model.countTokens('refused');
      return null;
    } catch (error) {
      const failure = error as Error & { code?: string; customErrorData?: { status?: number } };
      return { code: failure.code, status: failure.customErrorData?.status, message: failure.message };
    }
  });

  expect(refusal).toMatchObject({ code: 'fetch-error', status: 403 });
  expect(refusal?.message).toContain('[403 Forbidden] Firebase AI Logic has been deactivated in this project.');
});
