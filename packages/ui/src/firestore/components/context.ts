import { createContext, useContext } from 'react';
import type { DocumentReference } from 'pyric/firestore';

/**
 * Cross-cutting display context threaded into individual field
 * editors. Today it carries:
 *
 *   - `onReferenceClick` — fires when the reference Display
 *     component is activated. Consumers wire navigation here.
 *
 * Read by the per-type Display components via `useDisplayContext`.
 * Set by `<DocumentPreview>`'s wrapper. Editors that don't need it
 * (string, number, …) simply ignore the context.
 */
export interface DisplayContextValue {
  onReferenceClick?: (ref: DocumentReference) => void;
}

const Ctx = createContext<DisplayContextValue>({});

export const DisplayContextProvider = Ctx.Provider;

export function useDisplayContext(): DisplayContextValue {
  return useContext(Ctx);
}
