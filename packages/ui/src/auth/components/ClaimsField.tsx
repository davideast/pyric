import type { ReactNode } from 'react';

export interface ClaimsFieldProps {
  /** Raw claims JSON text. */
  value: string;
  onChange: (text: string) => void;
  /** Validation message (from `validateSerializedClaims` /
   *  `useAuthUserEditor().errors.claims`). Renders a `role="alert"`
   *  paragraph and marks the textarea invalid. */
  error?: string;
  /** Helper text under the field (rules-usage hint by default). */
  hint?: ReactNode;
  placeholder?: string;
  className?: string;
}

/**
 * Headless custom-claims textarea — the emulator UI's
 * `customAttributes` control. Standalone so custom forms can reuse the
 * exact field (the playground's sign-in helper and the user form both
 * render one); validation itself lives in `validateSerializedClaims`.
 */
export function ClaimsField({
  value,
  onChange,
  error,
  hint,
  placeholder = '{"role":"admin"}',
  className,
}: ClaimsFieldProps) {
  return (
    <div className={className} data-pyric-ui="claims-field">
      <textarea
        data-pyric-field="claims"
        data-pyric-claims-invalid={error != null ? '' : undefined}
        aria-label="Custom claims (optional)"
        aria-invalid={error != null || undefined}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {error != null && (
        <p role="alert" data-pyric-claims-error>
          {error}
        </p>
      )}
      {hint != null && <p data-pyric-claims-hint>{hint}</p>}
    </div>
  );
}
