<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# @pyric/cli/credentials/node

## Functions

### fromAdc()

> **fromAdc**(`projectId`, `env?`, `path?`): `Promise`\<`ProjectScope`\>

Build a `ProjectScope` from ADC, or `null` if no ADC file is present. The
project is supplied by the caller — an ADC user credential isn't bound to one
(`--project` / `.firebaserc`).

#### Parameters

##### projectId

`string`

##### env?

`ProcessEnv`

##### path?

`string`

#### Returns

`Promise`\<`ProjectScope`\>

***

### fromServiceAccount()

> **fromServiceAccount**(`saJsonOrPath`): `Promise`\<`ProjectScope`\>

Read the service account from a JSON file and return a
`ProjectScope` whose `resolveToken` is memoized internally.

The JSON file path can be:
- An absolute / relative filesystem path (Node only).
- A base64-encoded JSON string (when prefixed with `base64:`),
  for environments that ship the SA in an env var.

#### Parameters

##### saJsonOrPath

`string`

#### Returns

`Promise`\<`ProjectScope`\>
