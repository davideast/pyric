/**
 * Pure presence view-model mapping for the Studio shell (#227).
 */

import { describe, it, expect } from 'bun:test';
import {
  presenceViewModel,
  PRESENCE_BOUNDARY_COPY,
} from './presence.js';
import type { PresenceSnapshot } from '../clients/worker-live.js';

const NOW = 1_000_000;

function snap(clients: PresenceSnapshot['clients']): PresenceSnapshot {
  return { clients };
}

describe('presenceViewModel', () => {
  it('renders a quiet single-page state and marks This page', () => {
    const view = presenceViewModel(
      snap([
        {
          clientId: 'me',
          kind: 'studio',
          route: '/__pyric/studio/',
          visibility: 'visible',
          connectedAt: NOW - 10_000,
          lastSeen: NOW - 100,
        },
      ]),
      'me',
      NOW,
    );
    expect(view.count).toBe(1);
    expect(view.prominent).toBe(false);
    expect(view.chipLabel).toBe('1 page connected');
    expect(view.otherCount).toBe(0);
    expect(view.clients[0]?.isThisPage).toBe(true);
    expect(view.clients[0]?.kindLabel).toBe('Studio');
    expect(view.boundaryCopy).toBe(PRESENCE_BOUNDARY_COPY);
  });

  it('renders a prominent multi-page state with app/Studio distinction', () => {
    const view = presenceViewModel(
      snap([
        {
          clientId: 'app-1',
          kind: 'app',
          route: '/cart',
          visibility: 'hidden',
          connectedAt: NOW - 30_000,
          lastSeen: NOW - 2_000,
        },
        {
          clientId: 'me',
          kind: 'studio',
          route: '/__pyric/studio/',
          visibility: 'visible',
          connectedAt: NOW - 20_000,
          lastSeen: NOW,
        },
        {
          clientId: 'studio-2',
          kind: 'studio',
          route: '/__pyric/studio/?tab=data',
          visibility: 'visible',
          connectedAt: NOW - 5_000,
          lastSeen: NOW - 500,
        },
      ]),
      'me',
      NOW,
    );
    expect(view.count).toBe(3);
    expect(view.prominent).toBe(true);
    expect(view.chipLabel).toBe('3 pages connected');
    expect(view.otherCount).toBe(2);
    expect(view.clients[0]?.isThisPage).toBe(true);
    expect(view.clients.map((c) => c.kindLabel)).toContain('App');
    expect(view.clients.find((c) => c.clientId === 'app-1')?.visibilityLabel).toBe('Hidden');
    expect(view.boundaryCopy).toContain('browser profile');
  });
});
