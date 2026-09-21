import * as inPage from 'pyric/auth';
import { isEmailSignInLink } from 'pyric/auth/internal';
import * as worker from '../worker/client/auth-action-codes.js';
import { useWorker } from './worker-runtime.js';

export const sendSignInLinkToEmail = (useWorker ? worker.sendSignInLinkToEmail : inPage.sendSignInLinkToEmail) as typeof inPage.sendSignInLinkToEmail;
export const signInWithEmailLink = (useWorker ? worker.signInWithEmailLink : inPage.signInWithEmailLink) as typeof inPage.signInWithEmailLink;
export function isSignInWithEmailLink(auth: inPage.Auth, link: string): boolean {
  if (useWorker) return isEmailSignInLink(link);
  return inPage.isSignInWithEmailLink(auth, link);
}

export const sendPasswordResetEmail = (useWorker ? worker.sendPasswordResetEmail : inPage.sendPasswordResetEmail) as typeof inPage.sendPasswordResetEmail;
export const sendEmailVerification = (useWorker ? worker.sendEmailVerification : inPage.sendEmailVerification) as typeof inPage.sendEmailVerification;
export const verifyBeforeUpdateEmail = (useWorker ? worker.verifyBeforeUpdateEmail : inPage.verifyBeforeUpdateEmail) as typeof inPage.verifyBeforeUpdateEmail;
export const applyActionCode = (useWorker ? worker.applyActionCode : inPage.applyActionCode) as typeof inPage.applyActionCode;
export const checkActionCode = (useWorker ? worker.checkActionCode : inPage.checkActionCode) as typeof inPage.checkActionCode;
export const verifyPasswordResetCode = (useWorker ? worker.verifyPasswordResetCode : inPage.verifyPasswordResetCode) as typeof inPage.verifyPasswordResetCode;
export const confirmPasswordReset = (useWorker ? worker.confirmPasswordReset : inPage.confirmPasswordReset) as typeof inPage.confirmPasswordReset;
