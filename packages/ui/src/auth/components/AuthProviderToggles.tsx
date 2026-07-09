import { useState, type FormEvent } from 'react';
import { providerLabel } from '../providers.js';
import type { AuthProviderConfigEntry } from '../hooks/useAuthProviderConfig.js';

/** Providers always shown as a toggle row, regardless of whether the
 *  backend has an explicit entry for them yet (an unconfigured provider
 *  simply reads as disabled — same default the sandbox backend applies). */
export const DEFAULT_KNOWN_PROVIDER_IDS = [
  'password',
  'anonymous',
  'google.com',
  'github.com',
  'apple.com',
  'microsoft.com',
] as const;

export interface AuthProviderTogglesProps {
  /** Current config — usually `useAuthProviderConfig(auth).config`. */
  config: AuthProviderConfigEntry[];
  /** Fired when a toggle (known or custom) flips. */
  onToggle: (providerId: string, enabled: boolean) => void;
  /** Always-shown rows, in this order. Default: {@link DEFAULT_KNOWN_PROVIDER_IDS}. */
  knownProviderIds?: readonly string[];
  isLoading?: boolean;
  error?: Error;
  className?: string;
}

function isEnabled(config: AuthProviderConfigEntry[], providerId: string): boolean {
  return config.find((c) => c.providerId === providerId)?.enabled ?? false;
}

/**
 * Headless "Sign-in providers" toggle grid — the Authentication → Sign-in
 * method surface. Known providers (password / anonymous / the built-in OAuth
 * set) always render as a row; any OTHER provider already present in
 * `config` (a custom OAuth id a host previously added) also gets a row. A
 * free-text field lets a consumer enable an arbitrary OAuth provider id not
 * in the known set — this is a SECTION, not a dialog: the add row lives
 * inline, no modal.
 *
 * Fully headless: styling hangs off `data-pyric-*`, matching the rest of
 * `@pyric/ui/auth` (`AuthUserList`, `AuthUserForm`, …). Data + mutation come
 * from `useAuthProviderConfig`; this component only renders + fires events.
 */
export function AuthProviderToggles({
  config,
  onToggle,
  knownProviderIds = DEFAULT_KNOWN_PROVIDER_IDS,
  isLoading,
  error,
  className,
}: AuthProviderTogglesProps) {
  const [customId, setCustomId] = useState('');

  const customEntries = config.filter(
    (c) => !knownProviderIds.includes(c.providerId),
  );

  const handleAdd = (e: FormEvent) => {
    e.preventDefault();
    const id = customId.trim();
    if (!id) return;
    onToggle(id, true);
    setCustomId('');
  };

  return (
    <div className={className} data-pyric-ui="auth-provider-toggles">
      {error ? (
        <p data-pyric-provider-toggles-error role="alert">
          {error.message}
        </p>
      ) : null}
      <div role="list" aria-label="Sign-in providers" data-pyric-provider-toggle-list data-pyric-loading={isLoading ? '' : undefined}>
        {knownProviderIds.map((providerId) => (
          <ProviderToggleRow
            key={providerId}
            providerId={providerId}
            enabled={isEnabled(config, providerId)}
            onToggle={onToggle}
          />
        ))}
        {customEntries.map((entry) => (
          <ProviderToggleRow
            key={entry.providerId}
            providerId={entry.providerId}
            enabled={entry.enabled}
            onToggle={onToggle}
            custom
          />
        ))}
      </div>

      <form data-pyric-add-provider-form onSubmit={handleAdd}>
        <label data-pyric-field-label="custom-provider-id">
          <span data-pyric-label-text>Add a custom OAuth provider</span>
          <input
            type="text"
            data-pyric-field="custom-provider-id"
            placeholder="e.g. yahoo.com"
            value={customId}
            onChange={(e) => setCustomId(e.target.value)}
          />
        </label>
        <button type="submit" data-pyric-add-provider disabled={!customId.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}

function ProviderToggleRow({
  providerId,
  enabled,
  onToggle,
  custom,
}: {
  providerId: string;
  enabled: boolean;
  onToggle: (providerId: string, enabled: boolean) => void;
  custom?: boolean;
}) {
  const inputId = `auth-provider-toggle-${providerId}`;
  return (
    <div
      role="listitem"
      data-pyric-provider-toggle
      data-pyric-provider-id={providerId}
      data-pyric-provider-enabled={enabled ? '' : undefined}
      data-pyric-provider-custom={custom ? '' : undefined}
    >
      <label htmlFor={inputId} data-pyric-provider-toggle-label>
        <input
          id={inputId}
          type="checkbox"
          data-pyric-field="enabled"
          checked={enabled}
          onChange={(e) => onToggle(providerId, e.target.checked)}
        />
        <span data-pyric-provider-toggle-name>{providerLabel(providerId)}</span>
        <span data-pyric-provider-toggle-id>{providerId}</span>
      </label>
    </div>
  );
}
