import { describe, expect, test } from 'bun:test';
import { crashFindings, type EgressEntry, type TemplateEvidence } from './fresh-install-checks.ts';
import {
  formatAuthDialogState,
  signInThroughSandboxDialog,
  type AuthDialogState,
  type DialogSignInDriver,
} from './fresh-install-dialog.ts';

const REGISTRY: EgressEntry = { method: 'CONNECT', host: 'registry.npmjs.org', port: 443, allowed: true };

function baseState(overrides: Partial<AuthDialogState> = {}): AuthDialogState {
  return {
    dialogPresent: true,
    dialogOpen: true,
    emailValue: 'ada@example.com',
    identityCount: 1,
    dialogError: '',
    authStatus: 'Signed out',
    ...overrides,
  };
}

function fakeDriver(overrides: Partial<DialogSignInDriver> = {}, events: string[] = []): DialogSignInDriver {
  let currentEmail = '';
  return {
    async clickTrigger(selector) {
      events.push(`clickTrigger:${selector}`);
    },
    async waitForDialogOpen() {
      events.push('waitForDialogOpen');
    },
    async fillCredentials(email, displayName) {
      currentEmail = email;
      events.push(`fillCredentials:${email}:${displayName}`);
    },
    async readEmailValue() {
      events.push(`readEmailValue:${currentEmail}`);
      return currentEmail;
    },
    async clickSubmit() {
      events.push('clickSubmit');
    },
    async waitForDialogClose() {
      events.push('waitForDialogClose');
    },
    async waitForSignedInStatus() {
      events.push('waitForSignedInStatus');
    },
    async readState() {
      return baseState({ emailValue: currentEmail });
    },
    ...overrides,
  };
}

function findingsForFailure(reason: string): string[] {
  const evidence: TemplateEvidence = {
    template: 'static',
    failedStep: { step: 'sign in through the sandbox Google dialog', reason },
    browserLog: [],
    serverOutput: '',
    chipStates: ['Ready'],
    chip: 'expected',
  };
  return crashFindings({ templates: [evidence], egress: [REGISTRY] }, []).failing;
}

describe('signInThroughSandboxDialog (#2157)', () => {
  test('drives trigger, dialog open, credentials, submit, dialog close, and signed-in status in order', async () => {
    const events: string[] = [];
    await signInThroughSandboxDialog(fakeDriver({}, events), '#sign-in');
    expect(events).toEqual([
      'clickTrigger:#sign-in',
      'waitForDialogOpen',
      'fillCredentials:ada@example.com:Ada',
      'readEmailValue:ada@example.com',
      'clickSubmit',
      'waitForDialogClose',
      'waitForSignedInStatus',
    ]);
  });

  test('re-fills credentials once if an asynchronous render clears the email input before submit', async () => {
    const events: string[] = [];
    let reads = 0;
    let email = '';
    const driver = fakeDriver({
      async fillCredentials(nextEmail, displayName) {
        email = nextEmail;
        events.push(`fill:${nextEmail}:${displayName}`);
      },
      async readEmailValue() {
        reads += 1;
        if (reads === 1) {
          email = '';
        }
        events.push(`read:${email}`);
        return email;
      },
    }, events);

    await signInThroughSandboxDialog(driver, '#sign-in');
    expect(events).toContain('read:');
    expect(events.filter((entry) => entry.startsWith('fill:'))).toHaveLength(2);
    expect(events.at(-1)).toBe('waitForSignedInStatus');
  });

  test('fails at the submit phase when the email input stays empty, preserving DOM state on line 1', async () => {
    const driver = fakeDriver({
      async readEmailValue() {
        return '';
      },
      async readState() {
        return baseState({ emailValue: '', identityCount: 2 });
      },
    });

    let caught: Error | undefined;
    try {
      await signInThroughSandboxDialog(driver, '#sign-in');
    } catch (error) {
      if (error instanceof Error) caught = error;
      else throw error;
    }
    expect(caught).toBeDefined();
    const findings = findingsForFailure(caught?.message ?? '');
    expect(findings).toEqual([
      'static: sign in through the sandbox Google dialog failed: '
      + 'while filling credentials and clicking button.submit '
      + '[dialogPresent=true, dialogOpen=true, emailValue="", identityCount=2, dialogError="", authStatus="Signed out"]: '
      + 'email input did not hold "ada@example.com" before submit (got "")',
    ]);
  });

  test('distinguishes dialog-never-opened, dialog-stayed-open-after-submit, and post-close status timeouts in findings.txt', async () => {
    const openTimeoutDriver = fakeDriver({
      async waitForDialogOpen() {
        throw new Error('locator.waitFor: Timeout 30000ms exceeded.\nCall log:\n  - waiting for dialog');
      },
      async readState() {
        return baseState({ dialogPresent: false, dialogOpen: false, emailValue: '', identityCount: 0 });
      },
    });

    const closeTimeoutDriver = fakeDriver({
      async waitForDialogClose() {
        throw new Error('locator.waitFor: Timeout 30000ms exceeded.\nCall log:\n  - waiting for hidden');
      },
      async readState() {
        return baseState({ dialogPresent: true, dialogOpen: true, emailValue: '', identityCount: 1 });
      },
    });

    const statusTimeoutDriver = fakeDriver({
      async waitForSignedInStatus() {
        throw new Error('page.waitForFunction: Timeout 60000ms exceeded.\nCall log:\n  - waiting for function');
      },
      async readState() {
        return baseState({ dialogPresent: true, dialogOpen: false, emailValue: 'ada@example.com', authStatus: 'Signed out' });
      },
    });

    const messages: string[] = [];
    for (const candidate of [openTimeoutDriver, closeTimeoutDriver, statusTimeoutDriver]) {
      try {
        await signInThroughSandboxDialog(candidate, '#sign-in');
      } catch (error) {
        if (error instanceof Error) messages.push(findingsForFailure(error.message)[0] ?? '');
        else throw error;
      }
    }

    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain('while waiting for dialog[data-pyric-auth][open] to open [dialogPresent=false, dialogOpen=false');
    expect(messages[1]).toContain('while waiting for dialog[data-pyric-auth][open] to close after submit [dialogPresent=true, dialogOpen=true');
    expect(messages[2]).toContain('while waiting for #auth-status to match ^Signed in as  [dialogPresent=true, dialogOpen=false');
  });

  test('formatAuthDialogState handles unavailable DOM without newlines', () => {
    expect(formatAuthDialogState(undefined)).toBe('dom=unavailable');
    const multiline = baseState({ dialogError: 'line 1\nline 2', authStatus: 'Signed out\nnow' });
    expect(formatAuthDialogState(multiline)).not.toContain('\n');
  });
});
