import { ensureReactHook } from './runtime/react-hook.js';

/** A classic inline script runs before module dependency graphs can evaluate. */
export const REACT_BOOTSTRAP = `<script data-pyric-react-hook>try { (${ensureReactHook.toString()})(globalThis); } catch { /* Diagnostics must not prevent application startup. */ }</script>`;
