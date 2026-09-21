/** Runtime values from the installed Firebase SDK. */

export const FactorId = {
  PHONE: "phone",
  TOTP: "totp",
} as const;
export type FactorId = (typeof FactorId)[keyof typeof FactorId];
