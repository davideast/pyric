# How to test rules against the Firebase Rules Test API

Use the hosted Rules Test API when the local simulator returns `UNSUPPORTED`,
or when you want Firebase's production rules engine to evaluate a captured
Firestore session. The API evaluates rules; it does not deploy them.

## Run hosted verification

Capture a session with `pyric dev`, then run:

```sh
pyric verify \
  --service firestore \
  --engine rulesTestApi \
  --project your-project-id \
  --rules firestore=firestore.rules
```

`pyric verify` resolves credentials without owning an OAuth flow. It accepts,
in order, a service account from the environment, an existing Firebase CLI
login, or Google Application Default Credentials.

To run the local replay and hosted evaluation together, repeat `--engine`:

```sh
pyric verify \
  --service firestore \
  --engine sandbox \
  --engine rulesTestApi \
  --project your-project-id \
  --rules firestore=firestore.rules
```

The Rules Test API engine is Firestore-only. Realtime Database sessions use
the local sandbox engine.

## Handle authentication failures

`PERMISSION_DENIED` means the resolved identity cannot call
`firebaserules.releases.test` for the selected project. Grant only the role or
permission required by the Rules Test API, then retry. Pyric does not request
or store its own OAuth credentials.

## Where to look next

- For the tradeoffs between local and hosted evaluation, see
  [Simulator vs Rules Test API](../explanation/simulator-vs-rules-test-api.md).
- For the command and credential flags, see the
  [`@pyric/cli` reference](../../../../cli/docs/reference/cli.md).
- For handler error codes, see [Errors](../reference/errors.md).
