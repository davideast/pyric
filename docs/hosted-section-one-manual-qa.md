# Section 1 manual checkpoint

Use a disposable project. Keep the existing demo on port 43110 untouched.
This checkpoint covers request handling and lifecycle cleanup; Section 2 identity
and recovery semantics have their own acceptance work.

## Start the candidate

From this worktree, after its verified build:

```sh
repo_dir="$PWD"
qa_dir="$(mktemp -d "${TMPDIR:-/tmp}/pyric-section-one.XXXXXX")"
cp -R packages/cli/test/e2e/soak/fixture/. "$qa_dir/"
cp packages/cli/test/e2e/hosted/fixture/index.html "$qa_dir/index.html"
cp packages/cli/test/e2e/hosted/fixture/main.js "$qa_dir/main.js"
cd "$qa_dir"
node "$repo_dir/packages/cli/dist/cli/index.js" sandbox --hosted --ui --bridge --no-open --no-cache --no-capture --port 48765
```

Use Node 22.15 or later. Open the printed URL in two independent browsers. Keep this
terminal and temporary directory for the restart check. If the printed port differs
from 48765, use that printed port when restarting.

## Verify

1. In each browser console, evaluate
   `globalThis.__pyricRuntime?.getSnapshot().mode`; expect `hosted`.
2. Click **Write shared document** in each browser. Both pages should display
   `Hello from the other browser`, with no failed-write message.
3. Write a distinct value from either browser console, then repeat from the other:

   ```js
   const sdk = await import('firebase/firestore');
   await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'shared/greeting'), {
     message: `Manual check ${Date.now()}`,
   });
   ```

   Both existing pages should show the same latest value.
4. Stop the disposable server with Ctrl-C. Attempt a write while it is stopped;
   expect a connection error. Restart the same command in the same directory and
   port. Keep the pages open. New writes should succeed and their existing
   listeners should update again. Repeat once. A failed write must not appear
   later merely because the server reconnected.
5. Delete the app in one browser:

   ```js
   const apps = await import('firebase/app');
   await apps.deleteApp(apps.getApp());
   ```

   Write from the other browser. It should still work; the deleted app's listener
   should receive no new value. Reload the deleted page and verify it works again.
6. Stop the server. Restart in the same temporary directory with `--hosted`
   omitted. Reload two tabs in the same browser; expect `shared-worker` and a
   write/listener round trip. Separate browsers have separate SharedWorkers.

For a failure, record the step, browser, runtime mode, console error and whether
reloading changes the result. Do not begin Section 2 until this checkpoint is
reviewed. Stop the disposable server when finished; its data lives only in the
printed temporary directory.
