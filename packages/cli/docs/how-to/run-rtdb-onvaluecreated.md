# Run an RTDB `onValueCreated` function locally

Use `pyric dev` to run an existing Node
`firebase-functions/v2/database.onValueCreated` export against the same local
Realtime Database as your app and Pyric Studio. The function source keeps its
production imports and needs no credentials or deployment.

Your `firebase.json` must declare one Functions source:

```json
{
  "hosting": { "public": "public" },
  "functions": { "source": "functions" }
}
```

The source package's `main` field selects the built JavaScript entry. It
defaults to `index.js`:

```json
{
  "name": "my-functions",
  "private": true,
  "main": "lib/index.js",
  "dependencies": {
    "firebase-functions": "^7.2.5"
  }
}
```

Keep the production function unchanged:

```js
const { onValueCreated } = require('firebase-functions/v2/database');

exports.makeUppercase = onValueCreated(
  '/messages/{pushId}/original',
  event => event.data.ref.parent
    .child('uppercase')
    .set(event.data.val().toUpperCase()),
);
```

Build the Functions package if its `main` points at generated JavaScript, then
start the project:

```bash
npx pyric dev
```

Keep the browser tab that opens running. Pyric discovers the Functions entry,
starts it in an isolated Node child, and reports its supported exports:

```text
• functions waiting for the browser tab to connect the sandbox…
✔ functions 1 onValueCreated trigger from functions/lib/index.js
```

Create the matching value through your ordinary client code:

```js
import { getDatabase, ref, set } from 'firebase/database';

await set(ref(getDatabase(), 'messages/id/original'), 'hello');
```

The terminal reports the execution:

```text
✔ function  makeUppercase ← /messages/id/original
```

The app and Studio now read `messages/id/uppercase` as `"HELLO"` from that
same sandbox. Press Ctrl-C to stop both `pyric dev` and the Functions child.

## If an export is outside the first slice

Pyric prints each unsupported trigger export and leaves it inactive. The first
slice supports Node `onValueCreated`, one Functions source, one local RTDB
instance, exact paths and named single-segment wildcards, sequential delivery
within the current session, and Admin reads and writes through
`event.data.ref`.

Other RTDB trigger types, other Firebase products, retries, deployed
concurrency, multiple Functions codebases or database instances, durable
delivery across restarts, secrets, and deployment emulation remain outside the
slice. See the [Functions RTDB compatibility matrix](../functions-rtdb/COMPAT.md)
for the production-observed behaviour Pyric replays.
