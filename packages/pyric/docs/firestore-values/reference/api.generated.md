<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# pyric/firestore-values

## Functions

### rehydrateDocValue()

> **rehydrateDocValue**(`value`): `unknown`

Walk a parsed JSON tree and re-wrap any marker shape back into its real
wrapper-class instance. Visits arrays and plain objects recursively. Plain
values (and plain objects without a recognized discriminator) pass through.

This is the canonical rehydrate used by BOTH the sandbox persistence
serializer and the SharedWorker wire protocol, so the IDB format and the
MessagePort wire format are guaranteed identical.

#### Parameters

##### value

`unknown`

#### Returns

`unknown`
