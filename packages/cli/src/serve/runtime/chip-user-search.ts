import type { AuthUserRecord } from 'pyric/auth';

export interface UserSearchOptions {
  container: HTMLElement;
  onSelect: (user: AuthUserRecord) => void;
}

export interface UserSearchController {
  setUsers(users: AuthUserRecord[]): void;
  reset(): void;
  focus(): void;
}

export function userDisplayLabel(user: AuthUserRecord): string {
  if (user.displayName && user.displayName.trim().length > 0) {
    return user.displayName.trim();
  }
  if (user.email && user.email.trim().length > 0) {
    return user.email.trim();
  }
  return user.uid;
}

export function extractTenantFromUser(user: AuthUserRecord): string {
  const claims = user.customClaims ?? {};
  if (typeof claims.tenant === 'string') return claims.tenant;
  if (claims.firebase && typeof (claims.firebase as Record<string, unknown>).tenant === 'string') {
    return (claims.firebase as Record<string, unknown>).tenant as string;
  }
  return '';
}

export function getUserProviders(user: AuthUserRecord): string[] {
  const providers = (user.providerUserInfo ?? [])
    .map((p) => p.providerId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (user.isAnonymous && !providers.includes('anonymous')) {
    providers.push('anonymous');
  }
  return providers;
}

export function filterUsers(
  users: AuthUserRecord[],
  query: string,
  filter: string | null,
): AuthUserRecord[] {
  let list = users.filter((user) => user.disabled !== true);
  if (filter) {
    const f = filter.toLowerCase();
    if (f === 'admin') {
      list = list.filter((u) => {
        const c = u.customClaims ?? {};
        return c.admin === true || c.role === 'admin';
      });
    } else if (f === 'tenants') {
      list = list.filter((u) => Boolean(extractTenantFromUser(u)));
    } else {
      list = list.filter((u) => getUserProviders(u).includes(f));
    }
  }

  const q = query.trim().toLowerCase();
  if (!q) return list;

  return list.filter((u) => {
    if (q.startsWith('provider:')) {
      const target = q.slice(9).trim();
      return getUserProviders(u).some((p) => p.toLowerCase().includes(target));
    }
    if (q.startsWith('role:')) {
      const target = q.slice(5).trim();
      const c = u.customClaims ?? {};
      const role = String(c.role ?? '').toLowerCase();
      return role.includes(target);
    }
    if (q.startsWith('tenant:')) {
      const target = q.slice(7).trim();
      const tenant = extractTenantFromUser(u).toLowerCase();
      return tenant.includes(target);
    }
    if (q.startsWith('claim:')) {
      const spec = q.slice(6).trim();
      const delimiter = spec.includes('=') ? '=' : ':';
      const [key, val] = spec.split(delimiter).map((s) => s.trim());
      const c = u.customClaims ?? {};
      if (key && val !== undefined) {
        return String(c[key] ?? '').toLowerCase().includes(val);
      }
      return Object.keys(c).some((k) => k.toLowerCase().includes(spec));
    }
    if (q.includes(':') || q.includes('=')) {
      const delimiter = q.includes('=') ? '=' : ':';
      const [key, val] = q.split(delimiter).map((s) => s.trim());
      const c = u.customClaims ?? {};
      if (key && c[key] !== undefined && val !== undefined) {
        return String(c[key]).toLowerCase().includes(val);
      }
    }

    const name = (u.displayName ?? '').toLowerCase();
    const email = (u.email ?? '').toLowerCase();
    const uid = u.uid.toLowerCase();
    const tenant = extractTenantFromUser(u).toLowerCase();
    const providers = getUserProviders(u).join(' ').toLowerCase();
    const claims = JSON.stringify(u.customClaims ?? {}).toLowerCase();

    return (
      name.includes(q)
      || email.includes(q)
      || uid.includes(q)
      || tenant.includes(q)
      || providers.includes(q)
      || claims.includes(q)
    );
  });
}

export function createUserSearchController(options: UserSearchOptions): UserSearchController {
  const { container, onSelect } = options;
  const documentLike = container.ownerDocument;

  container.innerHTML = `
    <div class="user-search-box">
      <span class="user-search-icon" aria-hidden="true">⌕</span>
      <input
        type="text"
        class="user-search-input"
        data-user-search-input
        placeholder="Search name, uid, provider:google, role:admin..."
        autocomplete="off"
        role="combobox"
        aria-label="Search sandbox users"
        aria-autocomplete="list"
        aria-expanded="false"
        aria-controls="user-search-listbox"
      />
      <button type="button" class="user-search-clear-btn" data-search-clear-btn aria-label="Clear search" style="display: none;">✕</button>
    </div>
    <div class="filter-chips" data-filter-chips></div>
    <ul
      id="user-search-listbox"
      class="user-search-listbox"
      data-user-search-listbox
      role="listbox"
      aria-label="Matching users"
    ></ul>
  `;

  const input = container.querySelector<HTMLInputElement>('[data-user-search-input]')!;
  const clearBtn = container.querySelector<HTMLButtonElement>('[data-search-clear-btn]')!;
  const filterChipsEl = container.querySelector<HTMLElement>('[data-filter-chips]')!;
  const listbox = container.querySelector<HTMLUListElement>('[data-user-search-listbox]')!;

  let cachedUsers: AuthUserRecord[] = [];
  let currentMatches: AuthUserRecord[] = [];
  let activeFilter: string | null = null;
  let highlightedIndex = -1;

  const updateHighlight = (index: number): void => {
    highlightedIndex = index;
    const items = Array.from(listbox.querySelectorAll<HTMLElement>('.user-search-item'));
    items.forEach((item, idx) => {
      if (idx === highlightedIndex) {
        item.classList.add('highlighted');
        item.setAttribute('aria-selected', 'true');
        input.setAttribute('aria-activedescendant', item.id);
        item.scrollIntoView?.({ block: 'nearest' });
      } else {
        item.classList.remove('highlighted');
        item.setAttribute('aria-selected', 'false');
      }
    });
    if (highlightedIndex < 0) {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const renderFilterChips = (): void => {
    if (cachedUsers.length === 0) {
      filterChipsEl.innerHTML = '';
      return;
    }
    const categories: Array<{ id: string | null; label: string }> = [
      { id: null, label: 'All' },
    ];
    const hasAdmins = cachedUsers.some((u) => {
      const c = u.customClaims ?? {};
      return c.admin === true || c.role === 'admin';
    });
    if (hasAdmins) categories.push({ id: 'admin', label: 'Admins' });

    const hasTenants = cachedUsers.some((u) => Boolean(extractTenantFromUser(u)));
    if (hasTenants) categories.push({ id: 'tenants', label: 'Tenants' });

    const providerSet = new Set<string>();
    cachedUsers.forEach((u) => getUserProviders(u).forEach((p) => providerSet.add(p)));
    providerSet.forEach((p) => categories.push({ id: p, label: p }));

    filterChipsEl.replaceChildren();
    for (const category of categories) {
      const button = documentLike.createElement('button');
      button.type = 'button';
      button.className = 'filter-chip';
      const isSelected = activeFilter === category.id;
      if (isSelected) button.classList.add('selected');
      button.setAttribute('aria-pressed', String(isSelected));
      button.dataset.filter = category.id ?? '';
      button.textContent = category.label;
      filterChipsEl.append(button);
    }
  };

  const renderMatches = (): void => {
    currentMatches = filterUsers(cachedUsers, input.value, activeFilter);
    highlightedIndex = -1;
    input.removeAttribute('aria-activedescendant');

    if (currentMatches.length === 0) {
      const empty = documentLike.createElement('li');
      empty.className = 'user-search-empty';
      empty.setAttribute('role', 'presentation');
      empty.textContent = 'No matching users found in sandbox';
      listbox.replaceChildren(empty);
      input.setAttribute('aria-expanded', 'true');
      return;
    }

    const items = currentMatches.map((user, index) => {
      const label = userDisplayLabel(user);
      const tenant = extractTenantFromUser(user);
      const providers = getUserProviders(user);
      const claims = user.customClaims ?? {};
      let claimsSummary = '';
      if (Object.keys(claims).length > 0) {
        claimsSummary = JSON.stringify(claims).slice(0, 40);
      }

      const item = documentLike.createElement('li');
      item.id = `user-search-item-${index}`;
      item.className = 'user-search-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      item.dataset.userIndex = String(index);

      const main = documentLike.createElement('div');
      main.className = 'user-item-main';
      const name = documentLike.createElement('span');
      name.className = 'user-item-name';
      name.textContent = label;
      main.append(name);
      if (user.email && user.email !== label) {
        const email = documentLike.createElement('span');
        email.className = 'user-item-email';
        email.textContent = user.email;
        main.append(email);
      }
      const uid = documentLike.createElement('span');
      uid.className = 'user-item-uid';
      uid.textContent = user.uid;
      main.append(uid);

      const badges = documentLike.createElement('div');
      badges.className = 'user-item-badges';
      for (const provider of providers) {
        const badge = documentLike.createElement('span');
        badge.className = 'badge badge-provider';
        badge.textContent = provider;
        badges.append(badge);
      }
      if (tenant) {
        const badge = documentLike.createElement('span');
        badge.className = 'badge badge-tenant';
        badge.textContent = tenant;
        badges.append(badge);
      }
      if (claimsSummary) {
        const badge = documentLike.createElement('span');
        badge.className = 'badge badge-claims';
        badge.title = claimsSummary;
        badge.textContent = claimsSummary;
        badges.append(badge);
      }

      item.append(main, badges);
      return item;
    });
    listbox.replaceChildren(...items);

    listbox.style.display = 'block';
    input.setAttribute('aria-expanded', 'true');
  };

  input.addEventListener('input', () => {
    clearBtn.style.display = input.value.length > 0 ? 'inline-block' : 'none';
    renderMatches();
  });

  input.addEventListener('focus', () => {
    renderMatches();
  });

  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    input.value = '';
    clearBtn.style.display = 'none';
    renderMatches();
    input.focus();
  });

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (listbox.style.display === 'none') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        renderMatches();
        e.preventDefault();
        return;
      }
    }

    const items = Array.from(listbox.querySelectorAll<HTMLElement>('.user-search-item'));
    if (items.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = (highlightedIndex + 1) % items.length;
      updateHighlight(next);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = (highlightedIndex - 1 + items.length) % items.length;
      updateHighlight(prev);
    } else if (e.key === 'Enter') {
      if (highlightedIndex >= 0 && highlightedIndex < currentMatches.length) {
        e.preventDefault();
        const selected = currentMatches[highlightedIndex];
        onSelect(selected);
      }
    } else if (e.key === 'Escape') {
      if (input.value) {
        e.stopPropagation();
        input.value = '';
        clearBtn.style.display = 'none';
        renderMatches();
      }
    }
  });

  filterChipsEl.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    const target = (e.target as HTMLElement).closest<HTMLElement>('.filter-chip');
    if (!target) return;
    const filterVal = target.getAttribute('data-filter') || null;
    if (filterVal === null) {
      activeFilter = null;
    } else {
      activeFilter = activeFilter === filterVal ? null : filterVal;
    }
    renderFilterChips();
    renderMatches();
  });

  listbox.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    const target = (e.target as HTMLElement).closest<HTMLElement>('.user-search-item');
    if (!target) return;
    const idx = Number(target.getAttribute('data-user-index'));
    if (!Number.isNaN(idx) && currentMatches[idx]) {
      const selected = currentMatches[idx];
      onSelect(selected);
    }
  });

  return {
    setUsers(users: AuthUserRecord[]) {
      cachedUsers = users;
      renderFilterChips();
      renderMatches();
    },
    reset() {
      input.value = '';
      clearBtn.style.display = 'none';
      activeFilter = null;
      highlightedIndex = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      renderFilterChips();
      renderMatches();
    },
    focus() {
      input.focus();
    },
  };
}
