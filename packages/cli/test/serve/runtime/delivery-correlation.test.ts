import { describe, expect, it } from 'bun:test';
import {
  createDeliveryCorrelation,
  type DeliveryFlow,
} from '../../../src/serve/runtime/delivery-correlation.js';

/** A clock and a scheduler the test drives by hand. */
function fakeClock() {
  let now = 1_000;
  const timers: Array<{ at: number; run: () => void }> = [];
  return {
    now: () => now,
    schedule: (run: () => void, delayMs: number) => {
      const timer = { at: now + delayMs, run };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers
          .filter((timer) => timer.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        timers.splice(timers.indexOf(due), 1);
        now = due.at;
        due.run();
      }
      now = target;
    },
    outstanding: () => timers.length,
  };
}

function setup(windowMs = 250) {
  const clock = fakeClock();
  const flows: DeliveryFlow[] = [];
  const correlation = createDeliveryCorrelation({
    windowMs,
    now: clock.now,
    schedule: clock.schedule,
    onFlow: (flow) => flows.push(flow),
  });
  return { clock, flows, correlation };
}

describe('the delivery-to-commit window', () => {
  it('reports the nodes that changed between a delivery and the commit', () => {
    const page = setup();
    page.correlation.delivered('sub-1');
    page.correlation.changed(['a', 'b']);
    page.clock.advance(10);
    page.correlation.committed();

    expect(page.flows).toHaveLength(1);
    expect(page.flows[0].listenerId).toBe('sub-1');
    expect(page.flows[0].nodes).toEqual(['a', 'b']);
    expect(page.flows[0].elapsedMs).toBe(10);
  });

  it('ignores changes while no window is open', () => {
    const page = setup();
    page.correlation.changed(['stray']);
    page.correlation.committed();
    expect(page.flows).toHaveLength(0);
  });

  it('reports nothing when the commit changed no node', () => {
    const page = setup();
    page.correlation.delivered('sub-1');
    page.correlation.committed();
    expect(page.flows).toHaveLength(0);
    expect(page.correlation.pending()).toEqual([]);
  });

  it('drops a delivery no commit followed inside the window', () => {
    const page = setup(250);
    page.correlation.delivered('sub-1');
    page.correlation.changed(['a']);
    page.clock.advance(400);
    expect(page.correlation.pending()).toEqual([]);

    page.correlation.committed();
    expect(page.flows).toHaveLength(0);
  });

  it('keeps a delivery that is still inside its window', () => {
    const page = setup(250);
    page.correlation.delivered('sub-1');
    page.clock.advance(100);
    expect(page.correlation.pending()).toEqual(['sub-1']);
    page.correlation.changed(['a']);
    page.correlation.committed();
    expect(page.flows).toHaveLength(1);
  });

  it('attributes one commit to every delivery still open, and says so once each', () => {
    const page = setup();
    page.correlation.delivered('sub-1');
    page.clock.advance(5);
    page.correlation.delivered('sub-2');
    page.correlation.changed(['row']);
    page.correlation.committed();

    expect(page.flows.map((flow) => flow.listenerId)).toEqual(['sub-1', 'sub-2']);
    expect(page.flows[0].nodes).toEqual(['row']);
    expect(page.flows[1].nodes).toEqual(['row']);
  });

  it('drops only the expired delivery when a later one is still open', () => {
    const page = setup(250);
    page.correlation.delivered('sub-1');
    page.clock.advance(200);
    page.correlation.delivered('sub-2');
    page.clock.advance(100);

    expect(page.correlation.pending()).toEqual(['sub-2']);
  });

  it('starts each window fresh, so one commit is never reported twice', () => {
    const page = setup();
    page.correlation.delivered('sub-1');
    page.correlation.changed(['a']);
    page.correlation.committed();
    page.correlation.committed();
    expect(page.flows).toHaveLength(1);
  });

  it('cancels its sweep when disposed', () => {
    const page = setup();
    page.correlation.delivered('sub-1');
    expect(page.clock.outstanding()).toBe(1);
    page.correlation.dispose();
    expect(page.clock.outstanding()).toBe(0);
    expect(page.correlation.pending()).toEqual([]);
  });
});
