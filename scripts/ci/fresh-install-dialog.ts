/**
 * Drives the sandbox Google sign-in dialog in `scripts/ci/fresh-install.ts`
 * (#2157). Every phase is named, the email input is verified before submit, and
 * any timeout or failure formats its phase and live DOM state on line 1 so
 * `crashFindings` (`firstLine`) preserves it in `findings.txt`.
 */
import type { Page } from '@playwright/test';

const DIALOG_TIMEOUT_MS = 30_000;
const SIGN_IN_EMAIL = 'ada@example.com';
const SIGN_IN_NAME = 'Ada';

/** DOM state recorded when a sandbox auth dialog sign-in step fails (#2157). */
export interface AuthDialogState {
  dialogPresent: boolean;
  dialogOpen: boolean;
  emailValue: string;
  identityCount: number;
  dialogError: string;
  authStatus: string;
}

/** Actions of the sandbox Google dialog sign-in flow, narrow enough for unit tests (#2157). */
export interface DialogSignInDriver {
  clickTrigger(selector: string): Promise<void>;
  waitForDialogOpen(): Promise<void>;
  fillCredentials(email: string, displayName: string): Promise<void>;
  readEmailValue(): Promise<string>;
  clickSubmit(): Promise<void>;
  waitForDialogClose(): Promise<void>;
  waitForSignedInStatus(): Promise<void>;
  readState(): Promise<AuthDialogState | undefined>;
}

/** Formats `state` on one line so `crashFindings` (`firstLine`) keeps it in `findings.txt`. */
export function formatAuthDialogState(state: AuthDialogState | undefined): string {
  if (state === undefined) return 'dom=unavailable';
  return [
    `dialogPresent=${String(state.dialogPresent)}`,
    `dialogOpen=${String(state.dialogOpen)}`,
    `emailValue=${JSON.stringify(state.emailValue)}`,
    `identityCount=${String(state.identityCount)}`,
    `dialogError=${JSON.stringify(state.dialogError)}`,
    `authStatus=${JSON.stringify(state.authStatus)}`,
  ].join(', ');
}

/** Runs in the page: reads the current auth dialog and `#auth-status` snapshot. */
function readPageAuthDialogState(): AuthDialogState {
  const dialog = document.querySelector('dialog[data-pyric-auth]');
  const emailInput = dialog?.querySelector('input[type="email"]') as HTMLInputElement | null | undefined;
  return {
    dialogPresent: dialog !== null,
    dialogOpen: dialog?.hasAttribute('open') === true,
    emailValue: emailInput?.value ?? '',
    identityCount: dialog?.querySelectorAll('button.identity').length ?? 0,
    dialogError: dialog?.querySelector('[data-pyric-auth-error], .error')?.textContent?.trim() ?? '',
    authStatus: document.querySelector('#auth-status')?.textContent?.trim() ?? '',
  };
}

/**
 * Drives the sandbox Google sign-in dialog and waits for `#auth-status` (#2157).
 * Each phase is named, email input retention is checked before submit, and any
 * failure carries the phase and live DOM snapshot on line 1.
 */
export async function signInThroughSandboxDialog(driver: DialogSignInDriver, trigger: string): Promise<void> {
  let phase = `clicking sign-in trigger (${trigger})`;
  try {
    await driver.clickTrigger(trigger);
    phase = 'waiting for dialog[data-pyric-auth][open] to open';
    await driver.waitForDialogOpen();
    phase = 'filling credentials and clicking button.submit';
    await driver.fillCredentials(SIGN_IN_EMAIL, SIGN_IN_NAME);
    let emailBeforeSubmit = await driver.readEmailValue();
    if (emailBeforeSubmit !== SIGN_IN_EMAIL) {
      await driver.fillCredentials(SIGN_IN_EMAIL, SIGN_IN_NAME);
      emailBeforeSubmit = await driver.readEmailValue();
    }
    if (emailBeforeSubmit !== SIGN_IN_EMAIL) {
      throw new Error(`email input did not hold ${JSON.stringify(SIGN_IN_EMAIL)} before submit (got ${JSON.stringify(emailBeforeSubmit)})`);
    }
    await driver.clickSubmit();
    phase = 'waiting for dialog[data-pyric-auth][open] to close after submit';
    await driver.waitForDialogClose();
    phase = 'waiting for #auth-status to match ^Signed in as ';
    await driver.waitForSignedInStatus();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const state = await driver.readState();
    const headline = error.message.split('\n', 1)[0] ?? error.message;
    throw new Error(`while ${phase} [${formatAuthDialogState(state)}]: ${headline}`, { cause: error });
  }
}

/** Binds `DialogSignInDriver` to a live Playwright `Page` and its signed-in status check. */
export function playwrightDialogDriver(page: Page, waitSignedIn: () => Promise<unknown>): DialogSignInDriver {
  const openDialog = page.locator('dialog[data-pyric-auth][open]');
  const emailInput = openDialog.locator('input[type="email"]');
  const nameInput = openDialog.locator('input[placeholder="Display name (optional)"]');
  return {
    clickTrigger: (selector) => page.click(selector),
    waitForDialogOpen: () => openDialog.waitFor({ state: 'visible', timeout: DIALOG_TIMEOUT_MS }),
    async fillCredentials(email, displayName) {
      await emailInput.fill(email);
      await nameInput.fill(displayName);
    },
    readEmailValue: () => emailInput.inputValue(),
    clickSubmit: () => openDialog.locator('button.submit').click(),
    waitForDialogClose: () => openDialog.waitFor({ state: 'hidden', timeout: DIALOG_TIMEOUT_MS }),
    async waitForSignedInStatus() {
      await waitSignedIn();
    },
    async readState() {
      try {
        return await page.evaluate(readPageAuthDialogState);
      } catch (error) {
        if (error instanceof Error) return undefined;
        throw error;
      }
    },
  };
}
