# `pyric/storage`

Firebase Storage mirror for the Pyric sandbox. Its modular Web-SDK shape (`getStorage`, `ref`, `uploadBytes`, `getBytes`, `getDownloadURL`, `listAll`, `deleteObject`) is backed by IndexedDB. Production selection happens outside this package: normal builds resolve `firebase/storage`, while Pyric development swaps that import to this sandbox mirror.

Built for the agent-session-archive use case. The scope is bounded; the architecture validates the broader pattern for adding file-based services to `pyric/sandbox`.

## Check feature support

This package implements a deliberate subset of Firebase Storage. Query the central conformance model rather than relying on a hand-maintained scope list:

```bash
pyric can-i-use storage/uploadBytesResumable
pyric can-i-use storage/list
```

## Install

```bash
bun add pyric/storage pyric/sandbox
# or
npm install pyric/storage pyric/sandbox
```

## A 30-second example

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, ref, uploadBytes, getBlob } from 'pyric/storage';

const sandbox = initializeSandbox();
const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }));

await uploadBytes(
  ref(storage, 'sessions/gen-123'),
  new Blob(['{"task":"build a notes app"}']),
  { contentType: 'application/json' },
);

const blob = await getBlob(ref(storage, 'sessions/gen-123'));
console.log(await blob.text());
```

## Control-plane surface

Beyond the data-plane adapter, the package exports a control-plane surface for provisioning and managing real Cloud Storage buckets: `provisionStorage`, `getStorageServiceState`, `enableStorageService`, bucket listing, CORS management (`getBucketCors` / `setBucketCors`), and `deployStorageRules`. Alongside those sits `createStorageAdminTools`, a `ToolHandler[]` factory for an `@inbrowser/agent` registry. It also ships a local Storage rules engine (`parseStorageRules` / `evaluateStorageRules`).

## Where to go next

This documentation follows the [Diataxis](https://diataxis.fr/) framework:

| If you want to | Read |
|---|---|
| Follow a complete lesson | [Tutorials](./tutorials/) |
| Accomplish a specific task | [How-to guides](./how-to/) |
| Look up signatures and options | [Reference](./reference/) |
| Understand scope and design choices | [Explanation](./explanation/) |

### Starting points

- **Upload + download flow**: [Upload and download a session archive](./tutorials/01-upload-and-download.md).
- **Enforcing rules**: [Enforce Storage rules](./how-to/enforce-rules.md).
- **Checking current support**: run `pyric can-i-use storage/<symbol>` and follow its evidence link.

## Position in the Pyric stack

`pyric/storage` is the sandbox **storage data-plane adapter** (plus a thin control plane). It depends on `pyric/sandbox` for identity and lifecycle, `@pyric/cli` for package-level activation, and `@inbrowser/agent` for the tool-factory contract. It exposes the modular Web SDK's Storage surface without importing the production implementation.

The package's rules engine is local to the package. Storage rules use a different DSL from Firestore rules, so unlike `pyric/firestore` (which depends on `pyric/rules`), this package keeps the Storage-specific parser and evaluator in-tree.

## Licence

Same as the parent workspace.
