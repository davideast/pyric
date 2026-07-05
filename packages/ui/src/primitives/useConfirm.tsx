import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ConfirmDialog } from './ConfirmDialog.js';

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  destructive?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<ConfirmFn | null>(null);

/**
 * Imperative confirmation hook. Returns a function that opens the
 * provider-managed dialog and resolves to `true` on confirm, `false`
 * on cancel/dismiss.
 *
 *   const confirm = useConfirm();
 *   const ok = await confirm({ title: 'Delete?', destructive: true });
 *   if (ok) await deleteDoc(ref);
 *
 * Requires a `<ConfirmProvider>` ancestor.
 */
export function useConfirm(): ConfirmFn {
  const fn = useContext(Ctx);
  if (!fn) {
    throw new Error('useConfirm: missing <ConfirmProvider> ancestor');
  }
  return fn;
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

export interface ConfirmProviderProps {
  children: ReactNode;
  /** Forwarded to the rendered `<ConfirmDialog>`. */
  dialogClassName?: string;
}

/**
 * Mounts a single managed `<ConfirmDialog>` and exposes the
 * imperative `confirm()` API through context. Scoped — multiple
 * providers can coexist in different subtrees, each managing its
 * own dialog.
 */
export function ConfirmProvider({ children, dialogClassName }: ConfirmProviderProps) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Track which resolution path fired so the close handler doesn't
  // double-resolve when both onConfirm + onOpenChange(false) trigger.
  const resolvedRef = useRef(false);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      resolvedRef.current = false;
      setPending({ options, resolve });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    if (!pending) return;
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    pending.resolve(true);
    setPending(null);
  }, [pending]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) return;
      if (!pending) return;
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      pending.resolve(false);
      setPending(null);
    },
    [pending],
  );

  const ctxValue = useMemo(() => confirm, [confirm]);

  return (
    <Ctx.Provider value={ctxValue}>
      {children}
      {pending ? (
        <ConfirmDialog
          open
          onOpenChange={handleOpenChange}
          title={pending.options.title}
          body={pending.options.body}
          destructive={pending.options.destructive}
          confirmLabel={pending.options.confirmLabel}
          cancelLabel={pending.options.cancelLabel}
          onConfirm={handleConfirm}
          className={dialogClassName}
        />
      ) : null}
    </Ctx.Provider>
  );
}
