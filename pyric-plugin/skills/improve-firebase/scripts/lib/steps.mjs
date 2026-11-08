import { ContractValidationError } from './contracts.mjs';
import { signInActorPage } from './identity.mjs';
import { normalizeServiceName } from './op-snippet.mjs';

/**
 * Creates a strict single-flight executor with monotonic sequence numbering and
 * last-write-wins coalescing while an async operation is already in flight.
 *
 * When multiple updates arrive while a write is active, intermediate superseded
 * updates are dropped without overlapping, and only the latest pending update
 * executes immediately once the in-flight operation settles.
 *
 * @returns {{
 *   enqueue: (fn: (ctx: { seq: number }) => Promise<unknown> | unknown, meta?: unknown) => Promise<{ status: 'executed' | 'coalesced', seq: number, value?: unknown }>,
 *   run: (fn: (ctx: { seq: number }) => Promise<unknown> | unknown, meta?: unknown) => Promise<{ status: 'executed' | 'coalesced', seq: number, value?: unknown }>,
 *   flush: () => Promise<void>,
 *   stats: () => { seq: number, inFlight: boolean, activeCount: number, maxConcurrent: number, executedCount: number, droppedCount: number, enqueuedCount: number },
 * }}
 */
export function createSingleFlightRunner() {
  let seq = 0;
  let inFlight = false;
  let activeCount = 0;
  let maxConcurrent = 0;
  let executedCount = 0;
  let droppedCount = 0;
  let latestPending = null;
  let idleWaiters = [];

  function notifyIdleIfDone() {
    if (!inFlight && !latestPending) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  async function drainLoop() {
    if (inFlight) return;
    inFlight = true;

    try {
      while (latestPending) {
        const current = latestPending;
        latestPending = null;
        activeCount += 1;
        if (activeCount > maxConcurrent) {
          maxConcurrent = activeCount;
        }
        executedCount += 1;

        try {
          const value = await current.fn({ seq: current.seq, meta: current.meta });
          current.resolve({ status: 'executed', seq: current.seq, value });
        } catch (err) {
          current.reject(err);
        } finally {
          activeCount -= 1;
        }
      }
    } finally {
      inFlight = false;
      notifyIdleIfDone();
    }
  }

  function enqueue(fn, meta = undefined) {
    if (typeof fn !== 'function') {
      throw new ContractValidationError('createSingleFlightRunner.enqueue requires a function');
    }
    seq += 1;
    const mySeq = seq;

    if (latestPending) {
      const superseded = latestPending;
      droppedCount += 1;
      superseded.resolve({
        status: 'coalesced',
        seq: superseded.seq,
        supersededBy: mySeq,
      });
    }

    return new Promise((resolve, reject) => {
      latestPending = { seq: mySeq, fn, meta, resolve, reject };
      if (!inFlight) {
        drainLoop();
      }
    });
  }

  function flush() {
    if (!inFlight && !latestPending) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
    });
  }

  function stats() {
    return {
      seq,
      inFlight,
      activeCount,
      maxConcurrent,
      executedCount,
      droppedCount,
      enqueuedCount: seq,
    };
  }

  return {
    enqueue,
    run: enqueue,
    flush,
    stats,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveActorToken({ actorId, actors, tokenCache, sandbox }) {
  if (!actorId || actorId === 'anonymous') {
    return null;
  }
  const actorDef = actors && typeof actors === 'object' ? actors[actorId] : null;
  if (actorDef?.anonymous === true) {
    return null;
  }
  const uid = actorDef?.uid || actorId;
  const cacheKey = `${actorId}:${uid}`;
  if (tokenCache?.has(cacheKey)) {
    return tokenCache.get(cacheKey);
  }
  const token = await sandbox.mintCustomToken(uid, actorDef?.customClaims || actorDef?.claims || {});
  if (tokenCache) {
    tokenCache.set(cacheKey, token);
  }
  return token;
}

function interpolateFrameOperation(baseOperation, frame, index) {
  if (frame === undefined || frame === null) {
    return baseOperation;
  }
  if (typeof frame !== 'object') {
    return { ...(baseOperation || {}), data: frame };
  }
  if (frame.operation && typeof frame.operation === 'object') {
    return frame.operation;
  }
  const op = { ...(baseOperation || {}) };
  if (frame.path !== undefined) op.path = frame.path;
  if (frame.method !== undefined) op.method = frame.method;
  if (frame.data !== undefined) {
    op.data = frame.data;
  } else if (frame.value !== undefined) {
    op.value = frame.value;
  } else {
    op.data = { ...frame, frameIndex: index };
  }
  return op;
}

async function updateSyntheticCursor(page, coords) {
  if (!page || typeof page.evaluate !== 'function' || !coords) return;
  const x = Number(coords.x ?? 0);
  const y = Number(coords.y ?? 0);
  await page.evaluate(
    ({ cx, cy }) => {
      let el = document.querySelector('[data-pyric-cursor]');
      if (!el) {
        el = document.createElement('div');
        el.setAttribute('data-pyric-cursor', 'true');
        Object.assign(el.style, {
          position: 'fixed',
          left: '0px',
          top: '0px',
          width: '18px',
          height: '18px',
          borderRadius: '9999px',
          border: '2px solid #ffffff',
          background: 'rgba(239, 68, 68, 0.85)',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.35)',
          pointerEvents: 'none',
          zIndex: '2147483647',
          transform: 'translate(-50%, -50%)',
          transition: 'left 45ms linear, top 45ms linear',
        });
        document.body.appendChild(el);
      }
      el.style.left = `${cx}px`;
      el.style.top = `${cy}px`;
    },
    { cx: x, cy: y },
  );
}

async function moveCursorToLocator(page, locator) {
  try {
    const box = await locator.boundingBox();
    if (box) {
      const cx = Math.round(box.x + box.width / 2);
      const cy = Math.round(box.y + box.height / 2);
      await updateSyntheticCursor(page, { x: cx, y: cy });
      if (page.mouse?.move) {
        await page.mouse.move(cx, cy);
      }
      return { x: cx, y: cy };
    }
  } catch {
    // Ignore cursor helper errors if element has no bounding box
  }
  return null;
}

async function executeUiAction(page, actionSpec, showActions) {
  const kind = String(actionSpec.action || actionSpec.kind || actionSpec.type || 'click').toLowerCase();
  const timeout = Number(actionSpec.timeoutMs ?? 10_000);

  if (kind === 'wait') {
    await sleep(Number(actionSpec.ms ?? actionSpec.durationMs ?? 100));
    return { kind, ok: true };
  }
  if (kind === 'goto' && actionSpec.url) {
    await page.goto(actionSpec.url, { waitUntil: 'domcontentloaded' });
    return { kind, url: actionSpec.url, ok: true };
  }
  if (kind === 'reload') {
    await page.reload({ waitUntil: 'domcontentloaded' });
    return { kind, ok: true };
  }

  const target = actionSpec.selector
    ? page.locator(actionSpec.selector).first()
    : actionSpec.text
      ? page.getByText(actionSpec.text).first()
      : actionSpec.label
        ? page.getByLabel(actionSpec.label).first()
        : actionSpec.placeholder
          ? page.getByPlaceholder(actionSpec.placeholder).first()
          : null;

  if (kind === 'waitforselector' || kind === 'wait_for_selector') {
    if (!target) {
      throw new ContractValidationError('waitForSelector UI action requires selector or text');
    }
    await target.waitFor({ state: actionSpec.state || 'visible', timeout });
    return { kind, selector: actionSpec.selector, ok: true };
  }

  if (kind === 'drag') {
    const from = actionSpec.from || { x: 100, y: 100 };
    const to = actionSpec.to || { x: 260, y: 180 };
    if (showActions) {
      await updateSyntheticCursor(page, from);
    }
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    const steps = Math.max(2, Number(actionSpec.steps ?? 8));
    for (let i = 1; i <= steps; i += 1) {
      const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
      const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
      if (showActions) {
        await updateSyntheticCursor(page, { x, y });
      }
      await page.mouse.move(x, y);
      await sleep(16);
    }
    await page.mouse.up();
    return { kind, from, to, ok: true };
  }

  if (kind === 'press') {
    const key = actionSpec.key || 'Enter';
    if (target) {
      if (showActions) await moveCursorToLocator(page, target);
      await target.press(key, { timeout });
    } else {
      await page.keyboard.press(key);
    }
    return { kind, key, ok: true };
  }

  if (kind === 'fill') {
    if (!target) {
      throw new ContractValidationError('fill UI action requires selector/label/placeholder');
    }
    if (showActions) await moveCursorToLocator(page, target);
    await target.fill(String(actionSpec.value ?? actionSpec.text ?? ''), { timeout });
    return { kind, selector: actionSpec.selector, ok: true };
  }

  if (kind === 'type') {
    if (!target) {
      throw new ContractValidationError('type UI action requires selector/label/placeholder');
    }
    if (showActions) await moveCursorToLocator(page, target);
    await target.type(String(actionSpec.value ?? actionSpec.text ?? ''), {
      delay: Number(actionSpec.delayMs ?? 20),
      timeout,
    });
    return { kind, selector: actionSpec.selector, ok: true };
  }

  // Default: click
  if (target) {
    if (showActions) await moveCursorToLocator(page, target);
    await target.click({ timeout });
    return { kind: 'click', selector: actionSpec.selector, ok: true };
  }
  if (typeof actionSpec.x === 'number' && typeof actionSpec.y === 'number') {
    if (showActions) await updateSyntheticCursor(page, { x: actionSpec.x, y: actionSpec.y });
    await page.mouse.click(actionSpec.x, actionSpec.y);
    return { kind: 'click', x: actionSpec.x, y: actionSpec.y, ok: true };
  }

  throw new ContractValidationError(`UI action "${kind}" requires a selector, text, or x/y coordinates`);
}

async function evaluatePageExpectation(page, expectSpec) {
  if (expectSpec.selector) {
    const visible = await page
      .locator(expectSpec.selector)
      .first()
      .isVisible()
      .catch(() => false);
    if (!visible) {
      return { pass: false, reason: `Selector "${expectSpec.selector}" not visible` };
    }
  }
  if (expectSpec.notSelector) {
    const visible = await page
      .locator(expectSpec.notSelector)
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) {
      return { pass: false, reason: `Selector "${expectSpec.notSelector}" is unexpectedly visible` };
    }
  }
  if (expectSpec.text !== undefined) {
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const expected = String(expectSpec.text);
    if (!bodyText.includes(expected)) {
      return { pass: false, reason: `Expected text "${expected}" not found on page` };
    }
  }
  if (expectSpec.notText !== undefined) {
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const forbidden = String(expectSpec.notText);
    if (bodyText.includes(forbidden)) {
      return { pass: false, reason: `Forbidden text "${forbidden}" still present on page` };
    }
  }
  return { pass: true, reason: null };
}

/**
 * Executes a single security-audit scenario step (`sdk`, `ui`, `wait-expect`, `reload-rules`, or `sign-in`).
 *
 * @param {{
 *   step: object,
 *   actors?: Record<string, object>,
 *   actorPages?: Record<string, object>,
 *   sandbox: object,
 *   tokenCache?: Map<string, string>,
 *   captureBackend?: object,
 *   onEvent?: (event: object) => void,
 *   t0Ms?: number,
 * }} params
 * @returns {Promise<object>}
 */
export async function executeStep({
  step,
  actors = {},
  actorPages = {},
  sandbox,
  tokenCache = new Map(),
  captureBackend = null,
  onEvent = null,
  t0Ms = Date.now(),
} = {}) {
  if (!step || typeof step !== 'object') {
    throw new ContractValidationError('executeStep requires a step object');
  }

  const clockNow = typeof t0Ms === 'number' && Number.isFinite(t0Ms) && t0Ms < 1e11
    ? () => performance.now()
    : () => Date.now();
  const originMs = typeof t0Ms === 'number' && Number.isFinite(t0Ms) ? t0Ms : clockNow();
  const relMs = () => Math.max(0, Math.round((clockNow() - originMs) * 1000) / 1000);

  const kind = String(step.kind || step.type || '').trim().toLowerCase();
  const emit = (evt) => {
    if (typeof onEvent === 'function') {
      onEvent(evt);
    }
    if (captureBackend && typeof captureBackend.recordEvent === 'function') {
      captureBackend.recordEvent(evt);
    }
  };

  if (kind === 'sdk') {
    if (!sandbox) {
      throw new ContractValidationError('SDK step requires an active sandbox instance');
    }
    const idToken =
      step.idToken !== undefined
        ? step.idToken
        : await resolveActorToken({
            actorId: step.actor,
            actors,
            tokenCache,
            sandbox,
          });

    const frames = Array.isArray(step.frames)
      ? step.frames
      : Array.isArray(step.trajectory)
        ? step.trajectory
        : null;

    if (frames) {
      const rateHz = Math.max(1, Math.min(120, Number(step.rateHz ?? 60)));
      const intervalMs = 1000 / rateHz;
      const runner = createSingleFlightRunner();
      const events = [];

      const promises = [];
      for (let i = 0; i < frames.length; i += 1) {
        const frame = frames[i];
        const op = interpolateFrameOperation(step.operation, frame, i);
        const p = runner.enqueue(async ({ seq }) => {
          const res = await sandbox.executeOperation({ operation: op, idToken });
          const evt = {
            kind: 'sdk',
            actor: step.actor || null,
            seq,
            frameIndex: i,
            tMs: relMs(),
            service: normalizeServiceName(op.service),
            method: op.method,
            path: op.path ?? null,
            data: res.data ?? op.data ?? op.value ?? null,
            decision: res.decision,
            status: res.status,
            error: res.error,
            latencyMs: res.latencyMs,
          };
          if (typeof step.phase === 'string' && step.phase.trim()) {
            evt.phase = step.phase.trim();
          }
          events.push(evt);
          emit(evt);
          return evt;
        });
        promises.push(p);
        if (i < frames.length - 1) {
          await sleep(intervalMs);
        }
      }

      await Promise.all(promises);
      await runner.flush();

      return {
        kind: 'sdk',
        actor: step.actor || null,
        events,
        lastEvent: events[events.length - 1] ?? null,
        stats: runner.stats(),
      };
    }

    if (!step.operation) {
      throw new ContractValidationError('SDK step requires either `operation` or `frames`/`trajectory`');
    }

    const res = await sandbox.executeOperation({
      operation: step.operation,
      idToken,
    });
    const event = {
      kind: 'sdk',
      actor: step.actor || null,
      seq: 1,
      tMs: relMs(),
      service: normalizeServiceName(step.operation.service),
      method: step.operation.method,
      path: step.operation.path ?? null,
      data: res.data ?? step.operation.data ?? step.operation.value ?? null,
      decision: res.decision,
      status: res.status,
      error: res.error,
      latencyMs: res.latencyMs,
    };
    if (typeof step.phase === 'string' && step.phase.trim()) {
      event.phase = step.phase.trim();
    }
    emit(event);
    return {
      kind: 'sdk',
      actor: step.actor || null,
      event,
      decision: res.decision,
      status: res.status,
      error: res.error,
      data: res.data,
      latencyMs: res.latencyMs,
    };
  }

  if (kind === 'ui') {
    const actorKey = step.actor || 'owner';
    const page = actorPages[actorKey];
    if (!page) {
      throw new ContractValidationError(`UI step references unknown actor page "${actorKey}"`);
    }
    const showActions = step.showActions !== false;
    const actions = Array.isArray(step.actions) ? step.actions : [step];
    const results = [];
    for (const act of actions) {
      const out = await executeUiAction(page, act, showActions);
      results.push(out);
    }
    const event = {
      kind: 'ui',
      actor: actorKey,
      tMs: relMs(),
      results,
    };
    emit(event);
    return { kind: 'ui', actor: actorKey, results, event };
  }

  if (kind === 'wait-expect' || kind === 'wait_expect' || kind === 'expect') {
    const actorKey = step.actor || 'owner';
    const page = actorPages[actorKey];
    if (!page) {
      throw new ContractValidationError(`wait-expect step references unknown actor page "${actorKey}"`);
    }
    const actorExpect = actors[actorKey]?.expect || {};
    const expectSpec = {
      ...actorExpect,
      ...(step.expect && typeof step.expect === 'object' ? step.expect : {}),
      ...(step.text !== undefined ? { text: step.text } : {}),
      ...(step.notText !== undefined ? { notText: step.notText } : {}),
      ...(step.selector !== undefined ? { selector: step.selector } : {}),
      ...(step.notSelector !== undefined ? { notSelector: step.notSelector } : {}),
    };

    const timeoutMs = Number(step.timeoutMs ?? expectSpec.timeoutMs ?? 10_000);
    const pollMs = Math.max(25, Number(step.pollMs ?? 75));
    const deadline = Date.now() + timeoutMs;

    let lastCheck = await evaluatePageExpectation(page, expectSpec);
    while (!lastCheck.pass && Date.now() < deadline) {
      await sleep(pollMs);
      lastCheck = await evaluatePageExpectation(page, expectSpec);
    }

    if (!lastCheck.pass) {
      throw new Error(
        `wait-expect failed for actor "${actorKey}" after ${timeoutMs}ms: ${lastCheck.reason}`,
      );
    }

    const event = {
      kind: 'wait-expect',
      actor: actorKey,
      tMs: relMs(),
      expect: expectSpec,
      pass: true,
    };
    emit(event);
    return { kind: 'wait-expect', actor: actorKey, pass: true, event };
  }

  if (kind === 'reload-rules' || kind === 'reload_rules') {
    if (!sandbox) {
      throw new ContractValidationError('reload-rules step requires an active sandbox instance');
    }
    const result = await sandbox.updateRules({
      rtdbRules: step.rtdbRules,
      databaseRules: step.databaseRules,
      firestoreRules: step.firestoreRules,
      storageRules: step.storageRules,
    });
    const event = {
      kind: 'reload-rules',
      tMs: relMs(),
      ...result,
    };
    emit(event);
    return { kind: 'reload-rules', ...result, event };
  }

  if (kind === 'sign-in' || kind === 'sign_in') {
    const actorKey = step.actor || 'owner';
    const page = actorPages[actorKey];
    const actorDef = actors[actorKey] || { uid: actorKey };
    const signedIn = await signInActorPage({
      page,
      sandbox,
      actor: { ...actorDef, ...(step.view ? { view: step.view } : {}) },
      appUrl: step.appUrl || sandbox?.url,
      authEmulatorUrl: step.authEmulatorUrl,
    });
    const event = {
      kind: 'sign-in',
      actor: actorKey,
      tMs: relMs(),
      ...signedIn,
    };
    emit(event);
    return { kind: 'sign-in', actor: actorKey, ...signedIn, event };
  }

  if (kind === 'sleep' || kind === 'wait') {
    const ms = Math.max(0, Math.min(30_000, Number(step.ms ?? step.waitMs ?? 250)));
    await sleep(ms);
    const event = {
      kind: 'sleep',
      ms,
      tMs: relMs(),
    };
    emit(event);
    return { kind: 'sleep', ms, event };
  }

  throw new ContractValidationError(`Unsupported step kind "${step.kind}"`);
}
