/**
 * Watches the shared workers and service workers of one browser context for
 * uncaught exceptions and unhandled rejections. Playwright does not expose
 * shared workers, and it reports no errors from service workers, so this
 * reads them over a browser-level CDP session: it discovers each worker
 * target, attaches to it without flattening, enables `Runtime` through
 * `Target.sendMessageToTarget`, and reads `Runtime.exceptionThrown` from
 * `Target.receivedMessageFromTarget`. `Runtime.enable` replays the errors a
 * worker threw before the watch attached, such as one while its script ran.
 *
 * The browser is shared by every app in a run, so only targets in this
 * context's CDP browser context count. That id comes from one of the
 * context's pages; targets seen before it is known wait until it is.
 */
import type { BrowserContext, CDPSession, Page } from '@playwright/test';

/** A crash in a worker target. */
export interface TargetCrash {
  kind: string;
  source: string;
  message: string;
  stack: string[];
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  browserContextId?: string;
}

interface ExceptionDetails {
  exceptionId?: number;
  text?: string;
  exception?: { description?: string; value?: unknown };
}

const WATCHED_TYPES = new Map([['shared_worker', 'shared worker'], ['service_worker', 'service worker']]);

/** The printed error of a `Runtime.exceptionThrown`: the exception's description, or the console text and value. */
function describeException(details: ExceptionDetails): { message: string; stack: string[] } {
  const value = details.exception?.value;
  const printed = details.exception?.description ?? [details.text, value === undefined ? undefined : JSON.stringify(value)].filter(Boolean).join(' ');
  const [message = '(no message)', ...stack] = printed.split('\n');
  return { message, stack };
}

/** Chromium's text for an unhandled rejection is `Uncaught (in promise)`. */
function isRejection(details: ExceptionDetails): boolean {
  return details.text?.includes('(in promise)') === true;
}

export class WorkerTargetWatch {
  private contextId: string | undefined;
  private readonly waiting: TargetInfo[] = [];
  private readonly considered = new Set<string>();
  private readonly attached = new Map<string, TargetInfo>();
  private readonly reported = new Set<string>();

  constructor(private readonly session: CDPSession, private readonly record: (crash: TargetCrash) => void) {}

  /** Starts discovery; `Target.setDiscoverTargets` reports the targets that already exist too. */
  async start(): Promise<void> {
    this.session.on('Target.targetCreated', ({ targetInfo }) => this.consider(targetInfo));
    this.session.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => this.read(sessionId, message));
    await this.session.send('Target.setDiscoverTargets', { discover: true });
  }

  /** The CDP browser context the watched targets belong to. */
  setContextId(id: string): void {
    if (this.contextId !== undefined) return;
    this.contextId = id;
    for (const target of this.waiting.splice(0)) this.consider(target);
  }

  get knowsContext(): boolean {
    return this.contextId !== undefined;
  }

  private consider(target: TargetInfo): void {
    if (!WATCHED_TYPES.has(target.type)) return;
    if (this.contextId === undefined) {
      this.waiting.push(target);
      return;
    }
    const isOurs = target.browserContextId === this.contextId;
    if (!isOurs || this.considered.has(target.targetId)) return;
    this.considered.add(target.targetId);
    void this.attach(target);
  }

  private async attach(target: TargetInfo): Promise<void> {
    try {
      const { sessionId } = await this.session.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
      this.attached.set(sessionId, target);
      await this.session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.enable' }) });
    } catch {
      // The worker ended before the watch attached.
    }
  }

  private read(sessionId: string, text: string): void {
    const target = this.attached.get(sessionId);
    if (!target) return;
    let message: { method?: string; params?: { exceptionDetails?: ExceptionDetails } };
    try { message = JSON.parse(text) as typeof message; } catch { return; }
    const details = message.params?.exceptionDetails;
    if (message.method !== 'Runtime.exceptionThrown' || !details) return;
    const key = `${sessionId}:${details.exceptionId ?? text}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    const label = WATCHED_TYPES.get(target.type)!;
    const kind = `${label} ${isRejection(details) ? 'unhandled rejection' : 'uncaught exception'}`;
    this.record({ kind, source: `${label} ${target.url}`, ...describeException(details) });
  }

  async detach(): Promise<void> {
    await this.session.detach().catch(() => {});
  }
}

/** The CDP id of the browser context `page` is in. */
async function browserContextIdOf(context: BrowserContext, page: Page): Promise<string | undefined> {
  const session = await context.newCDPSession(page);
  try {
    const { targetInfo } = await session.send('Target.getTargetInfo');
    return targetInfo.browserContextId;
  } finally {
    await session.detach().catch(() => {});
  }
}

/** Watches `context`'s shared and service workers, reporting each crash to `record`. */
export async function watchWorkerTargets(context: BrowserContext, record: (crash: TargetCrash) => void): Promise<void> {
  const browser = context.browser();
  if (!browser) return;
  const watch = new WorkerTargetWatch(await browser.newBrowserCDPSession(), record);
  await watch.start();
  const learn = async (page: Page) => {
    if (watch.knowsContext) return;
    const id = await browserContextIdOf(context, page).catch(() => undefined);
    if (id !== undefined) watch.setContextId(id);
  };
  context.on('page', (page) => void learn(page));
  for (const page of context.pages()) await learn(page);
  context.on('close', () => void watch.detach());
}
