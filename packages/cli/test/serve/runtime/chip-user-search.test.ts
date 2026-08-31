import { describe, it, expect, beforeEach } from 'bun:test';
import { JSDOM } from 'jsdom';
import {
  createUserSearchController,
  filterUsers,
  extractTenantFromUser,
  getUserProviders,
  userDisplayLabel,
} from '../../../src/serve/runtime/chip-user-search.js';
import type { AuthUserRecord } from 'pyric/auth';

describe('chip-user-search', () => {
  const mockUsers: AuthUserRecord[] = [
    {
      uid: 'user-1',
      email: 'alice@example.com',
      displayName: 'Alice Smith',
      providerUserInfo: [{ providerId: 'password' }],
      customClaims: { role: 'admin', admin: true },
    },
    {
      uid: 'user-2',
      email: 'bob@example.com',
      displayName: 'Bob Jones',
      providerUserInfo: [{ providerId: 'google.com' }],
      customClaims: { tenant: 'tenant-omega' },
    },
    {
      uid: 'user-3',
      email: null,
      displayName: null,
      isAnonymous: true,
      providerUserInfo: [],
      customClaims: {},
    },
  ];

  describe('utility helpers', () => {
    it('userDisplayLabel extracts displayName, email, or uid in priority order', () => {
      expect(userDisplayLabel(mockUsers[0])).toBe('Alice Smith');
      expect(userDisplayLabel({ uid: 'u1', email: 'test@example.com', displayName: '  ' })).toBe('test@example.com');
      expect(userDisplayLabel(mockUsers[2])).toBe('user-3');
    });

    it('extractTenantFromUser extracts from tenant or firebase.tenant', () => {
      expect(extractTenantFromUser(mockUsers[1])).toBe('tenant-omega');
      expect(extractTenantFromUser({ uid: 'u1', customClaims: { firebase: { tenant: 'nested-t' } } })).toBe('nested-t');
      expect(extractTenantFromUser(mockUsers[0])).toBe('');
    });

    it('getUserProviders extracts provider IDs including anonymous', () => {
      expect(getUserProviders(mockUsers[0])).toEqual(['password']);
      expect(getUserProviders(mockUsers[1])).toEqual(['google.com']);
      expect(getUserProviders(mockUsers[2])).toEqual(['anonymous']);
    });
  });

  describe('filterUsers', () => {
    it('returns all users when query and filter are empty', () => {
      expect(filterUsers(mockUsers, '', null)).toEqual(mockUsers);
    });

    it('filters by category filter chips (admin, tenants, providers)', () => {
      expect(filterUsers(mockUsers, '', 'admin')).toEqual([mockUsers[0]]);
      expect(filterUsers(mockUsers, '', 'tenants')).toEqual([mockUsers[1]]);
      expect(filterUsers(mockUsers, '', 'google.com')).toEqual([mockUsers[1]]);
      expect(filterUsers(mockUsers, '', 'anonymous')).toEqual([mockUsers[2]]);
    });

    it('filters by freeform text matching name, email, or uid', () => {
      expect(filterUsers(mockUsers, 'alice', null)).toEqual([mockUsers[0]]);
      expect(filterUsers(mockUsers, 'bob@example.com', null)).toEqual([mockUsers[1]]);
      expect(filterUsers(mockUsers, 'user-3', null)).toEqual([mockUsers[2]]);
    });

    it('filters by qualifier prefix provider:, role:, tenant:, claim:', () => {
      expect(filterUsers(mockUsers, 'provider:google', null)).toEqual([mockUsers[1]]);
      expect(filterUsers(mockUsers, 'role:admin', null)).toEqual([mockUsers[0]]);
      expect(filterUsers(mockUsers, 'tenant:omega', null)).toEqual([mockUsers[1]]);
      expect(filterUsers(mockUsers, 'claim:role=admin', null)).toEqual([mockUsers[0]]);
    });
  });

  describe('controller DOM interactions', () => {
    let container: HTMLElement;
    let dom: JSDOM;

    beforeEach(() => {
      dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
      globalThis.document = dom.window.document;
      globalThis.HTMLElement = dom.window.HTMLElement;
      globalThis.KeyboardEvent = dom.window.KeyboardEvent;
      globalThis.Event = dom.window.Event;
      container = dom.window.document.createElement('div');
      dom.window.document.body.appendChild(container);
    });

    it('mounts combobox and renders filter chips and candidates', () => {
      let selectedUser: AuthUserRecord | null = null;
      const controller = createUserSearchController({
        container,
        onSelect: (u) => {
          selectedUser = u;
        },
      });

      controller.setUsers(mockUsers);

      const input = container.querySelector<HTMLInputElement>('[data-user-search-input]')!;
      const listbox = container.querySelector<HTMLUListElement>('[data-user-search-listbox]')!;
      const chips = container.querySelectorAll<HTMLButtonElement>('.filter-chip');

      expect(input).toBeDefined();
      expect(chips.length).toBeGreaterThan(0);

      // Focus input triggers candidate rendering
      input.focus();
      const items = listbox.querySelectorAll<HTMLElement>('.user-search-item');
      expect(items.length).toBe(3);

      // Click first candidate
      items[0].click();
      expect(selectedUser).toEqual(mockUsers[0]);
    });

    it('supports keyboard navigation via ArrowDown, ArrowUp, and Enter', () => {
      let selectedUser: AuthUserRecord | null = null;
      const controller = createUserSearchController({
        container,
        onSelect: (u) => {
          selectedUser = u;
        },
      });

      controller.setUsers(mockUsers);
      const input = container.querySelector<HTMLInputElement>('[data-user-search-input]')!;
      const listbox = container.querySelector<HTMLUListElement>('[data-user-search-listbox]')!;

      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

      const highlighted = listbox.querySelector<HTMLElement>('.user-search-item.highlighted');
      expect(highlighted).toBeDefined();
      expect(input.getAttribute('aria-activedescendant')).toBe(highlighted?.id ?? '');

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(selectedUser).toEqual(mockUsers[0]);
    });

    it('clears query when clear button is clicked', () => {
      const controller = createUserSearchController({
        container,
        onSelect: () => {},
      });
      controller.setUsers(mockUsers);

      const input = container.querySelector<HTMLInputElement>('[data-user-search-input]')!;
      const clearBtn = container.querySelector<HTMLButtonElement>('[data-search-clear-btn]')!;

      input.value = 'alice';
      input.dispatchEvent(new Event('input'));
      expect(clearBtn.style.display).toBe('inline-block');

      clearBtn.click();
      expect(input.value).toBe('');
      expect(clearBtn.style.display).toBe('none');
    });
  });
});
