/** The lines the Listeners surfaces state, as strings. */
import { describe, expect, it } from 'bun:test';
import type { ActivityIncident } from 'pyric/firestore/internal';
import {
  attachAgesLine,
  incidentLine,
  listenerFactLine,
  listenerHeadline,
  listenerOwnerFact,
  serviceWord,
  type ListenerFold,
} from './listener-facts.js';

function fold(overrides: Partial<ListenerFold> = {}): ListenerFold {
  return { listeners: 0, duplicates: [], churn: 0, ...overrides };
}

function incident(overrides: Partial<ActivityIncident>): ActivityIncident {
  return {
    fingerprint: 'f1',
    pattern: 'duplicate-listener',
    count: 2,
    windowMs: 10_000,
    ...overrides,
  } as ActivityIncident;
}

describe('the headline', () => {
  it('counts the listeners and stops', () => {
    expect(listenerHeadline(fold({ listeners: 9 }))).toBe('9 listeners');
    expect(listenerHeadline(fold({ listeners: 1 }))).toBe('1 listener');
  });

  it('names the duplicates and how many times the worst one attached', () => {
    expect(listenerHeadline(fold({ listeners: 9, duplicates: [2] }))).toBe(
      '9 listeners, 1 attached twice',
    );
    expect(listenerHeadline(fold({ listeners: 9, duplicates: [2, 4] }))).toBe(
      '9 listeners, 2 attached 4 times',
    );
  });

  it('names churn when nothing is duplicated', () => {
    expect(listenerHeadline(fold({ listeners: 9, churn: 2 }))).toBe(
      '9 listeners, 2 listeners reattaching',
    );
  });

  it('says so when nothing is attached', () => {
    expect(listenerHeadline(fold())).toBe('No listeners attached');
  });
});

describe('the owner line', () => {
  it('names the owner holding more than one listener', () => {
    expect(listenerOwnerFact(fold({ listeners: 9, busiest: { label: 'ChatPage', count: 7 } }))).toBe(
      'ChatPage · 7 listeners',
    );
  });

  it('has nothing to say when no owner holds more than one', () => {
    expect(
      listenerOwnerFact(fold({ listeners: 3, busiest: { label: 'ChatPage', count: 1 } })),
    ).toBeUndefined();
    expect(listenerOwnerFact(fold({ listeners: 3 }))).toBeUndefined();
  });
});

describe('a listener’s fact line', () => {
  it('runs owner, element, service, and attach age', () => {
    expect(
      listenerFactLine(
        {
          owner: 'ChatPage',
          element: 'nav#conversations',
          service: 'firestore',
          attachedAt: 0,
        },
        24 * 60_000,
      ),
    ).toBe('ChatPage · nav#conversations · Firestore · attached 24m ago');
  });

  it('leaves out what was never recorded', () => {
    expect(listenerFactLine({ service: 'database', attachedAt: 0 }, 20_000)).toBe(
      'Database · attached 20s ago',
    );
  });

  it('names the service as the word the reader uses', () => {
    expect(serviceWord('firestore')).toBe('Firestore');
    expect(serviceWord('database')).toBe('Database');
  });
});

describe('the incident line', () => {
  it('states a duplicate, its owner, and every attach age', () => {
    expect(incidentLine(incident({ count: 2 }), 'ChatPage', ['24m ago', '20s ago'])).toBe(
      'Attached twice by ChatPage · 24m ago and 20s ago',
    );
    expect(incidentLine(incident({ count: 3 }), 'ChatPage', ['2h ago', '24m ago', '20s ago'])).toBe(
      'Attached 3 times by ChatPage · 2h ago, 24m ago and 20s ago',
    );
  });

  it('states churn as a count over a window', () => {
    expect(
      incidentLine(
        incident({ pattern: 'listener-churn', count: 40, windowMs: 10_000 }),
        'ChatPage',
        [],
      ),
    ).toBe('Reattached 40 times in 10s by ChatPage');
  });

  it('drops the owner when no owner was recorded', () => {
    expect(incidentLine(incident({ count: 2 }), undefined, ['20s ago'])).toBe(
      'Attached twice · 20s ago',
    );
  });

  it('joins one age, two ages, and three ages', () => {
    expect(attachAgesLine([])).toBe('');
    expect(attachAgesLine(['20s ago'])).toBe('20s ago');
    expect(attachAgesLine(['24m ago', '20s ago'])).toBe('24m ago and 20s ago');
  });
});
