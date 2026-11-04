/**
 * `@pyric/live/register`: live mode for a Node process.
 *
 *   node --import @pyric/live/register server.js
 *
 * The process's `firebase/app`, `firebase/auth`, `firebase/firestore` and
 * `firebase/app-check` are the app's own installed SDK, wrapped by the live
 * rows, so the app talks to its real project. Each wrapped Firestore and
 * Auth call's outcome reaches the Node host (`pyric sandbox --hosted`) as an
 * observed call, and the chip shows it as production's row from a server
 * process. Every other Firebase import, and `firebase-admin`, is refused
 * (`refusal.ts`).
 *
 * It is `@pyric/cli`'s register hooks with the live rows, through the one
 * internal seam. The seam takes nothing from this file: it opens the rows
 * only when `@pyric/live` is installed in the project, and loads the row
 * modules' source and the refusal from that installed package
 * (`node-modules.ts`).
 */
import { activateWithSuppliedRows } from '@pyric/cli/register/internal/supplied-rows';

await activateWithSuppliedRows();
