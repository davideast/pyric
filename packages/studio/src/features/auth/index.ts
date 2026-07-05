/**
 * Auth surface (Pyric Studio · S-AUTH): public surface.
 *
 * `AuthSurface.tsx` composes `@pyric/ui/auth` (`AuthUserList` + `AuthUserForm` +
 * `ClaimsField`) over the seeded sandbox `Auth` handle from the dev-seed context
 * into the users master-detail. `auth.css` (imported by the component) skins the
 * `data-pyric-*` contract with the swappable theme tokens.
 *
 * The orchestrator mounts `<AuthSurface />` at the `#auth` route during shell
 * integration; this feature does not touch routing.
 */

export { AuthSurface, type AuthSurfaceProps } from './AuthSurface.js';
