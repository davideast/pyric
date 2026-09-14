import type { RequestEvent } from 'pyric/sandbox';
import type { PyricVerifyFixture } from '../../verify/fixture.js';
import { initPayload } from '../entries/init-payload.js';

const events: RequestEvent[] = [];
const producerId = crypto.randomUUID();

async function flushCapture(): Promise<void> {
  const payload = await initPayload;
  const isCaptureEnabled = payload?.capture === true;
  if (isCaptureEnabled) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const sessionToken = payload.sessionToken;
    const hasSessionToken = sessionToken !== undefined;
    if (hasSessionToken) headers['x-pyric-session-token'] = sessionToken;
    const fixture: PyricVerifyFixture = {
      schema: 'pyric.verify.fixture.v1',
      capturedBy: producerId,
      createdAt: new Date().toISOString(),
      events,
      // A live read does not establish a complete database snapshot or deployed rules.
      services: {},
    };
    const response = await fetch('/__pyric/capture', {
      method: 'POST',
      headers,
      body: JSON.stringify(fixture),
    });
    const hasFailed = !response.ok;
    if (hasFailed) throw new Error(`Live capture failed: HTTP ${response.status}`);
  }
}

/** Recording errors belong to diagnostics, never to the application's SDK result. */
export function recordLiveRequest(event: RequestEvent): void {
  events.push(event);
  void flushCapture().catch((error: unknown) => {
    console.warn('[pyric] Live observation could not be captured.', error);
  });
}
