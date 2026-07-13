<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# @pyric/cli/register

## Variables

### active

> **active**: `boolean`

Whether this process's firebase-admin/firebase imports are being rewritten
 to the pyric sandbox — true only when `PYRIC_SANDBOX` was set (and not
 refused by the production guard) at the moment this module loaded.
