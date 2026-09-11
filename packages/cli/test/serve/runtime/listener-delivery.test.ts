import { describe, expect, it } from 'bun:test';
import {
  onListenerDelivery,
  reportListenerDelivery,
} from '../../../src/serve/worker/client/listener-delivery.js';

describe('the delivery hook the read paths report to', () => {
  it('hands every subscriber the subscription id that delivered', () => {
    const seen: string[] = [];
    const stop = onListenerDelivery((listenerId) => seen.push(listenerId));

    reportListenerDelivery('sub-1');
    reportListenerDelivery('sub-2');
    expect(seen).toEqual(['sub-1', 'sub-2']);

    stop();
    reportListenerDelivery('sub-3');
    expect(seen).toEqual(['sub-1', 'sub-2']);
  });

  it('reports to every subscriber and survives one that throws', () => {
    const seen: string[] = [];
    const stopFirst = onListenerDelivery(() => {
      throw new Error('diagnostic');
    });
    const stopSecond = onListenerDelivery((listenerId) => seen.push(listenerId));

    expect(() => reportListenerDelivery('sub-1')).not.toThrow();
    expect(seen).toEqual(['sub-1']);
    stopFirst();
    stopSecond();
  });

  it('costs nothing when nobody is watching', () => {
    expect(() => reportListenerDelivery('sub-1')).not.toThrow();
  });
});
