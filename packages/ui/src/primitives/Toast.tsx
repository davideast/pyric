import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastInput {
  title: string;
  body?: ReactNode;
  kind?: ToastKind;
  /** Auto-dismiss after this many ms. `0` makes the toast sticky;
   *  default is 5000. */
  duration?: number;
}

export interface ToastRecord extends ToastInput {
  id: string;
}

interface ToastContextValue {
  toast: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  toasts: ReadonlyArray<ToastRecord>;
}

const Ctx = createContext<ToastContextValue | null>(null);

/**
 * Imperative toast hook. Returns `{ toast, dismiss, toasts }`.
 *
 *   const { toast } = useToast();
 *   toast({ title: 'Saved.', kind: 'success' });
 *
 * Requires a `<ToastProvider>` ancestor.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error('useToast: missing <ToastProvider> ancestor');
  }
  return ctx;
}

export interface ToastProviderProps {
  children: ReactNode;
  /** Default auto-dismiss in ms. Per-toast `duration` overrides.
   *  Default 5000; pass `0` to make sticky-by-default. */
  defaultDuration?: number;
  /** Forwarded to the rendered container. */
  className?: string;
  /** Region label for assistive tech. Defaults to "Notifications". */
  regionLabel?: string;
}

/**
 * Toast queue host. Mounts a single live region into `document.body`
 * via portal and exposes the imperative API via context. Scoped —
 * a subtree can host its own provider for isolated queues if needed.
 *
 * Headless: every node carries structural `data-*` attributes, no
 * shipped CSS. Auto-dismiss timers are kept per-toast.
 */
export function ToastProvider({
  children,
  defaultDuration = 5000,
  className,
  regionLabel = 'Notifications',
}: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastContextValue['toast']>(
    (input) => {
      const id = crypto.randomUUID();
      const duration = input.duration ?? defaultDuration;
      setToasts((prev) => [...prev, { id, ...input }]);
      if (duration > 0) {
        // Schedule auto-dismiss. The timer fires `dismiss(id)`
        // which is idempotent (filter on a missing id is a no-op).
        window.setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, duration);
      }
      return id;
    },
    [defaultDuration],
  );

  const value = useMemo<ToastContextValue>(
    () => ({ toast, dismiss, toasts }),
    [toast, dismiss, toasts],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <ToastRegion
        toasts={toasts}
        dismiss={dismiss}
        className={className}
        regionLabel={regionLabel}
      />
    </Ctx.Provider>
  );
}

interface ToastRegionProps {
  toasts: ReadonlyArray<ToastRecord>;
  dismiss: (id: string) => void;
  className?: string;
  regionLabel: string;
}

function ToastRegion({ toasts, dismiss, className, regionLabel }: ToastRegionProps) {
  // SSR guard. Astro `client:only` consumers won't see this branch
  // hit, but it keeps the import safe in mixed environments.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <ol
      aria-label={regionLabel}
      aria-live="polite"
      data-pyric-ui="toast-region"
      className={className}
    >
      {toasts.map((t) => (
        <li
          key={t.id}
          data-pyric-toast
          data-pyric-toast-kind={t.kind ?? 'info'}
          role={t.kind === 'error' ? 'alert' : 'status'}
        >
          <div data-pyric-toast-title>{t.title}</div>
          {t.body ? <div data-pyric-toast-body>{t.body}</div> : null}
          <button
            type="button"
            data-pyric-toast-dismiss
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
          >
            ×
          </button>
        </li>
      ))}
    </ol>,
    document.body,
  );
}
