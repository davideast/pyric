import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
   *  default is 0 (sticky by default per WCAG 2.2.1). */
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
   *  Default 0 (sticky by default per WCAG 2.2.1); pass positive ms for auto-dismiss. */
  defaultDuration?: number;
  /** Forwarded to the rendered container. */
  className?: string;
  /** Region label for assistive tech. Defaults to "Notifications". */
  regionLabel?: string;
}

/**
 * Toast queue host. Mounts a single region into `document.body`
 * via portal and exposes the imperative API via context. Scoped —
 * a subtree can host its own provider for isolated queues if needed.
 *
 * Headless: every node carries structural `data-*` attributes, no
 * shipped CSS. Auto-dismiss timers are kept per-toast with pause controls
 * on hover and focus to satisfy WCAG 2.2.1 Timing Adjustable.
 */
export function ToastProvider({
  children,
  defaultDuration = 0,
  className,
  regionLabel = 'Notifications',
}: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timersRef = useRef<Map<string, {
    timerId: ReturnType<typeof setTimeout> | number | null;
    remaining: number;
    startTime: number;
  }>>(new Map());

  const dismiss = useCallback((id: string) => {
    const entry = timersRef.current.get(id);
    if (entry?.timerId !== null && entry?.timerId !== undefined) {
      window.clearTimeout(entry.timerId);
    }
    timersRef.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pause = useCallback((id: string) => {
    const entry = timersRef.current.get(id);
    if (!entry || entry.timerId === null) return;
    window.clearTimeout(entry.timerId);
    const elapsed = Date.now() - entry.startTime;
    const remaining = Math.max(0, entry.remaining - elapsed);
    timersRef.current.set(id, {
      timerId: null,
      remaining,
      startTime: 0,
    });
  }, []);

  const resume = useCallback((id: string) => {
    const entry = timersRef.current.get(id);
    if (!entry || entry.timerId !== null || entry.remaining <= 0) return;
    const timerId = window.setTimeout(() => {
      dismiss(id);
    }, entry.remaining);
    timersRef.current.set(id, {
      timerId,
      remaining: entry.remaining,
      startTime: Date.now(),
    });
  }, [dismiss]);

  const toast = useCallback<ToastContextValue['toast']>(
    (input) => {
      const id = crypto.randomUUID();
      const duration = input.duration ?? defaultDuration;
      setToasts((prev) => [...prev, { id, ...input }]);
      if (duration > 0) {
        const timerId = window.setTimeout(() => {
          dismiss(id);
        }, duration);
        timersRef.current.set(id, {
          timerId,
          remaining: duration,
          startTime: Date.now(),
        });
      }
      return id;
    },
    [defaultDuration, dismiss],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const entry of timers.values()) {
        if (entry.timerId !== null) {
          window.clearTimeout(entry.timerId);
        }
      }
      timers.clear();
    };
  }, []);

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
        pause={pause}
        resume={resume}
        className={className}
        regionLabel={regionLabel}
      />
    </Ctx.Provider>
  );
}

interface ToastRegionProps {
  toasts: ReadonlyArray<ToastRecord>;
  dismiss: (id: string) => void;
  pause: (id: string) => void;
  resume: (id: string) => void;
  className?: string;
  regionLabel: string;
}

function ToastRegion({ toasts, dismiss, pause, resume, className, regionLabel }: ToastRegionProps) {
  // SSR guard. Astro `client:only` consumers won't see this branch
  // hit, but it keeps the import safe in mixed environments.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <ol
      aria-label={regionLabel}
      role="region"
      tabIndex={-1}
      data-pyric-ui="toast-region"
      className={className}
    >
      {toasts.map((t) => (
        <li
          key={t.id}
          data-pyric-toast
          data-pyric-toast-kind={t.kind ?? 'info'}
          role={t.kind === 'error' ? 'alert' : undefined}
          onMouseEnter={() => pause(t.id)}
          onMouseLeave={() => resume(t.id)}
          onFocus={() => pause(t.id)}
          onBlur={() => resume(t.id)}
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
