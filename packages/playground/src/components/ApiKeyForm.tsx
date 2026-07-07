/**
 * Reusable API-key entry form. Multiple provider rows. Identical to
 * jules.ink's `ApiKeyForm` in shape; generalized for N providers.
 */
import { useState } from 'react';

export interface ApiKeyField {
  id: string;
  label: string;
  placeholder?: string;
  hint?: string;
  initialValue?: string;
  /**
   * Input variant. `secret` (default) is a password input — used for
   * cloud-provider API keys. `url` is a plain text input rendered with
   * client-side `http(s)://` validation — used for local-first
   * providers like Ollama where the "credential" is a base URL.
   */
  variant?: 'secret' | 'url';
  /**
   * Optional dismissible warning rendered above the field — typically
   * an inline hint about provider quirks (e.g. Ollama CORS) that the
   * user needs to know about before the request succeeds.
   */
  warning?: {
    /** React node — supports embedded anchor tags. */
    body: React.ReactNode;
  };
  /**
   * Optional synchronous validator. Returns null when valid, an error
   * string when not. Surfaced under the input and blocks submit.
   */
  validate?: (value: string) => string | null;
}

export interface ApiKeyFormProps {
  title?: string;
  subtitle?: string;
  fields: ApiKeyField[];
  onSubmit: (values: Record<string, string>) => void;
  disabled?: boolean;
  error?: string | null;
  submitLabel?: string;
  footerText?: string | null;
}

export function ApiKeyForm({
  title = 'API keys',
  subtitle = 'Bring your own keys. Stored in this browser only.',
  fields,
  onSubmit,
  disabled,
  error,
  submitLabel = 'Save',
  footerText = null,
}: ApiKeyFormProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const f of fields) initial[f.id] = f.initialValue ?? '';
    return initial;
  });

  // Per-field validation errors. Recomputed on every render — cheap,
  // and avoids stale state when the user clears a problematic input.
  // We only surface the error when the field has user input; an empty
  // field is "ignored on submit" (idempotent parent handler), not
  // "invalid."
  const fieldErrors: Record<string, string | null> = {};
  for (const f of fields) {
    const v = values[f.id] ?? '';
    if (v.trim().length > 0 && f.validate) {
      fieldErrors[f.id] = f.validate(v);
    } else {
      fieldErrors[f.id] = null;
    }
  }
  const hasFieldError = Object.values(fieldErrors).some((e) => e !== null);

  // Allow save when AT LEAST ONE field has new content. The previous
  // "every field non-empty" rule blocked the common case where one
  // provider's key is already set (masked placeholder, value === '')
  // and the user is just adding a second provider's key — the parent
  // handler is idempotent and only persists non-empty values.
  const canSubmit =
    !disabled &&
    !hasFieldError &&
    fields.some((f) => (values[f.id] ?? '').trim().length > 0);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const trimmed: Record<string, string> = {};
    for (const f of fields) trimmed[f.id] = values[f.id]!.trim();
    onSubmit(trimmed);
  };

  return (
    <div className="w-full max-w-[480px] flex flex-col gap-10">
      <div className="flex flex-col gap-4">
        <div>
          <span className="material-symbols-outlined text-[32px] text-slate-gray opacity-50">
            key
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-[20px] font-display text-soft-white font-medium leading-tight">
            {title}
          </h2>
          <p className="text-[13px] text-slate-gray leading-normal">{subtitle}</p>
        </div>
      </div>

      <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
        {fields.map((f) => {
          const variant = f.variant ?? 'secret';
          const err = fieldErrors[f.id];
          return (
            <div key={f.id} className="flex flex-col gap-2">
              <label className="text-[11px] uppercase tracking-wide text-slate-gray font-medium font-display">
                {f.label}
              </label>
              {f.warning ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-200/90 leading-snug">
                  {f.warning.body}
                </div>
              ) : null}
              <input
                className="w-full bg-content-bg border border-[#2a2a35] rounded-md px-3 py-2.5 text-[14px] text-soft-white placeholder:text-slate-gray/40 focus:outline-none focus:border-slate-gray transition-colors font-mono"
                placeholder={f.placeholder ?? ''}
                type={variant === 'url' ? 'url' : 'password'}
                inputMode={variant === 'url' ? 'url' : undefined}
                autoComplete={variant === 'url' ? 'off' : 'new-password'}
                spellCheck={false}
                value={values[f.id] ?? ''}
                onChange={(e) => setValues((s) => ({ ...s, [f.id]: e.target.value }))}
              />
              {err ? (
                <span className="text-[12px] text-red-400">{err}</span>
              ) : f.hint ? (
                <span className="text-[12px] text-slate-gray opacity-60">{f.hint}</span>
              ) : null}
            </div>
          );
        })}

        <div className="pt-2">
          {error ? <p className="text-[12px] text-red-500 mb-2">{error}</p> : null}
          <button
            className={`w-full rounded-full bg-soft-white text-content-bg py-2.5 text-[14px] font-semibold transition-colors ${
              canSubmit ? 'hover:bg-white cursor-pointer' : 'opacity-40 cursor-not-allowed'
            }`}
            type="submit"
            disabled={!canSubmit}
          >
            {disabled ? 'Saving…' : submitLabel}
          </button>
        </div>
      </form>

      {footerText ? (
        <div className="text-center">
          <p className="text-[12px] text-slate-gray opacity-50">{footerText}</p>
        </div>
      ) : null}
    </div>
  );
}
