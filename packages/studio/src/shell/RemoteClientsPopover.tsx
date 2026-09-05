/**
 * Remote Clients Popover & Identity Switcher.
 *
 * Displays connected mobile clients (Flutter, iOS Swift, Android Kotlin) discovered
 * over the Pyric Bridge. Provides 1-click remote identity switching between App Session,
 * Admin Bypass, Anonymous, and Impersonated Users (populated from sandbox auth.listUsers)
 * with custom claims and tenant support.
 */

import { useEffect, useState, type RefObject } from 'react';
import type { AuthLens, RemoteConsumerRecord } from '@pyric/cli/bridge/client';
import type { Auth, AuthUserRecord } from 'pyric/auth';
import { useAuthUsers } from '@pyric/ui/auth';
import './remote-clients.css';

export interface RemoteClientsPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  consumers: RemoteConsumerRecord[];
  onSetLens: (clientSessionId: string, lens: AuthLens) => Promise<boolean> | void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  auth?: Auth;
}

function freshnessLabel(lastSeen: number, now: number = Date.now()): string {
  const ageMs = Math.max(0, now - lastSeen);
  if (ageMs < 5_000) return 'just now';
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  return `${Math.floor(ageMs / 3_600_000)}h ago`;
}

function platformBadge(platform: string) {
  const p = platform.toLowerCase();
  if (p === 'flutter') {
    return <span className="studio-remote-client__badge studio-remote-client__badge--flutter">Flutter</span>;
  }
  if (p === 'swift' || p === 'ios') {
    return <span className="studio-remote-client__badge studio-remote-client__badge--swift">iOS Swift</span>;
  }
  if (p === 'kotlin' || p === 'android') {
    return <span className="studio-remote-client__badge studio-remote-client__badge--kotlin">Android Kotlin</span>;
  }
  return <span className="studio-remote-client__badge">{platform}</span>;
}

function lensLabel(lens?: AuthLens): string {
  if (!lens || lens.mode === 'app-session') return 'App Session';
  if (lens.mode === 'admin') return 'Admin Bypass';
  if (lens.mode === 'anon') return 'Anonymous';
  if (lens.mode === 'as') {
    const claims = lens.token ? ` +claims` : '';
    const tenant = lens.tenant ? ` @${lens.tenant}` : '';
    return `User: ${lens.uid}${claims}${tenant}`;
  }
  return 'Unknown';
}

function UserSelector({
  auth,
  onSelectUser,
}: {
  auth: Auth;
  onSelectUser: (user: AuthUserRecord) => void;
}) {
  const { users, isLoading } = useAuthUsers(auth);

  return (
    <select
      className="studio-remote-client__select"
      defaultValue=""
      disabled={isLoading || users.length === 0}
      onChange={(e) => {
        const found = users.find((u) => u.uid === e.target.value);
        if (found) {
          onSelectUser(found);
          e.target.value = '';
        }
      }}
    >
      <option value="" disabled>
        {isLoading ? 'Loading sandbox users…' : users.length === 0 ? 'No sandbox users found' : 'Impersonate sandbox user…'}
      </option>
      {users.map((u) => (
        <option key={u.uid} value={u.uid}>
          {u.email ? `${u.email} (${u.uid.slice(0, 6)}…)` : u.uid}
        </option>
      ))}
    </select>
  );
}

export function RemoteClientsPopover({
  isOpen,
  onClose,
  consumers,
  onSetLens,
  triggerRef,
  auth,
}: RemoteClientsPopoverProps) {
  const [activeTabUid, setActiveTabUid] = useState<string>('');
  const [customClaimsJson, setCustomClaimsJson] = useState<string>('');
  const [tenantId, setTenantId] = useState<string>('');
  const [showCustom, setShowCustom] = useState<boolean>(false);
  const [manualUid, setManualUid] = useState<string>('');

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        triggerRef?.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, triggerRef]);

  if (!isOpen) return null;

  const authHandle = auth;

  const applyUserLens = (clientSessionId: string, uid: string) => {
    let token: Record<string, unknown> | undefined;
    if (customClaimsJson.trim()) {
      try {
        token = JSON.parse(customClaimsJson);
      } catch {
        alert('Invalid JSON for custom claims');
        return;
      }
    }
    const tenant = tenantId.trim() || undefined;
    void onSetLens(clientSessionId, { mode: 'as', uid, token, tenant });
  };

  return (
    <>
      <div className="studio-remote-clients__backdrop" onMouseDown={onClose} />
      <div
        id="studio-remote-clients-panel"
        className="studio-remote-clients__panel"
        role="dialog"
        aria-label="Remote Mobile Clients"
      >
        <div className="studio-remote-clients__header">
          <h3 className="studio-remote-clients__title">Remote Mobile Clients</h3>
          <span className="studio-remote-clients__count">
            {consumers.length} connected
          </span>
        </div>

        {consumers.length === 0 ? (
          <p className="studio-remote-clients__empty">
            No remote mobile clients connected over the bridge. Connect your Flutter,
            iOS, or Android app to control its identity remotely.
          </p>
        ) : (
          <ul className="studio-remote-clients__list">
            {consumers.map((c) => (
              <li key={c.clientSessionId} className="studio-remote-clients__item">
                <div className="studio-remote-clients__item-top">
                  <div className="studio-remote-clients__item-info">
                    {platformBadge(c.platform)}
                    <span className="studio-remote-clients__device">
                      {c.deviceLabel || 'Mobile Device'}
                    </span>
                  </div>
                  <span className="studio-remote-clients__freshness">
                    {freshnessLabel(c.lastSeen)}
                  </span>
                </div>

                <div className="studio-remote-clients__session">
                  Session: <code>{c.clientSessionId.slice(0, 10)}…</code>
                </div>

                <div className="studio-remote-clients__current-lens">
                  <span className="studio-remote-clients__lens-label">Active Lens:</span>
                  <span className="studio-remote-clients__lens-pill">
                    {lensLabel(c.activeLens)}
                  </span>
                </div>

                <div className="studio-remote-clients__actions">
                  <div className="studio-remote-clients__btn-group">
                    <button
                      type="button"
                      className={`studio-remote-btn ${c.activeLens?.mode === 'app-session' ? 'studio-remote-btn--active' : ''}`}
                      onClick={() => void onSetLens(c.clientSessionId, { mode: 'app-session' })}
                    >
                      App Session
                    </button>
                    <button
                      type="button"
                      className={`studio-remote-btn ${c.activeLens?.mode === 'admin' ? 'studio-remote-btn--active' : ''}`}
                      onClick={() => void onSetLens(c.clientSessionId, { mode: 'admin' })}
                    >
                      Admin
                    </button>
                    <button
                      type="button"
                      className={`studio-remote-btn ${c.activeLens?.mode === 'anon' ? 'studio-remote-btn--active' : ''}`}
                      onClick={() => void onSetLens(c.clientSessionId, { mode: 'anon' })}
                    >
                      Anon
                    </button>
                  </div>

                  <div className="studio-remote-clients__switcher">
                    {authHandle ? (
                      <UserSelector
                        auth={authHandle}
                        onSelectUser={(u) => applyUserLens(c.clientSessionId, u.uid)}
                      />
                    ) : (
                      <div className="studio-remote-clients__manual-row">
                        <input
                          type="text"
                          placeholder="Impersonate UID…"
                          className="studio-remote-client__input"
                          value={activeTabUid === c.clientSessionId ? manualUid : ''}
                          onChange={(e) => {
                            setActiveTabUid(c.clientSessionId);
                            setManualUid(e.target.value);
                          }}
                        />
                        <button
                          type="button"
                          className="studio-remote-btn studio-remote-btn--primary"
                          disabled={!manualUid.trim()}
                          onClick={() => {
                            applyUserLens(c.clientSessionId, manualUid.trim());
                            setManualUid('');
                          }}
                        >
                          Switch
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="studio-remote-clients__advanced">
                    <button
                      type="button"
                      className="studio-remote-clients__advanced-toggle"
                      onClick={() => setShowCustom(!showCustom)}
                    >
                      {showCustom ? '▲ Hide Claims & Tenant' : '▼ Custom Claims / Tenant'}
                    </button>
                    {showCustom ? (
                      <div className="studio-remote-clients__advanced-inputs">
                        <input
                          type="text"
                          placeholder="Custom Claims JSON, e.g. { role: 'admin' }"
                          className="studio-remote-client__input"
                          value={customClaimsJson}
                          onChange={(e) => setCustomClaimsJson(e.target.value)}
                        />
                        <input
                          type="text"
                          placeholder="Tenant ID (optional)"
                          className="studio-remote-client__input"
                          value={tenantId}
                          onChange={(e) => setTenantId(e.target.value)}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
