import { StrictMode } from 'react';
import { App } from './App.js';

/** Browser-only Studio module consumed by the Astro host. */
export function StudioApp({ brandLogoSrc }: { brandLogoSrc?: string } = {}) {
  return (
    <StrictMode>
      <App brandLogoSrc={brandLogoSrc} />
    </StrictMode>
  );
}
