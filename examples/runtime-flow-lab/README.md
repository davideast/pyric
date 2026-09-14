# Runtime Flow studies

A working chat example for comparing **five standard** and **ten experimental** Flow treatments. The chat uses separate subscriptions for messages, presence, typing, and read receipts. Messages also update the unread badge; presence updates both the header and member list.

Run from the repository root after installing the workspace dependencies:

```sh
bun examples/runtime-flow-lab/serve.ts
```

Open [the example](http://localhost:5197). Set `FLOW_LAB_PORT` to choose another port. Restart the server after editing TypeScript; CSS and HTML are read on each request.

Choose a treatment, then use **New message**, **Presence**, **Typing**, **Read receipt**, or **Run a burst**. Choosing a treatment repeats the last delivery so you can compare it immediately. **Clear marks & history** clears visual history while preserving the chat data. **Inspector** opens or minimizes the actual runtime chip.

All deliveries and user records are fixture data. The React renderer, commit hook, listener folding, and Flow painter are the real implementation. A render after a delivery is correlation, not proof that particular data reached every marked component. All fifteen treatments come from the runtime registry; the example and chip load the same styles and annotations.

Portraits use Pyric's URL-backed avatar resolver with sample images from Pravatar. The resolver caches them in the system temporary directory; failed downloads fall back to generated avatars. Browser fonts are bundled locally.

## Treatments

### Standard

| Treatment       | Visual idea                                                               | Useful for                                                 |
| --------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Crisp outline   | A thin listener-colored perimeter and component label.                    | The default choice for checking render boundaries.         |
| Soft highlight  | A translucent color wash briefly illuminates the updated region.          | Spotting changes while keeping the app readable.           |
| Activity rail   | A narrow inset rail marks the start edge of updated content.              | Dense lists and message feeds where full boxes feel noisy. |
| Corner brackets | Four brackets frame the rendered component without boxing in its content. | Reading large components with less visual obstruction.     |
| Label only      | A compact component tag appears above each update; no region tint.        | Checking which component names appear during a delivery.   |

### Experimental

| Treatment            | Visual idea                                                                     | Useful for                                                          |
| -------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Radar pulse          | A single expanding perimeter announces each new render.                         | Catching occasional updates in peripheral vision.                   |
| Scanner pass         | A fine horizontal band travels through the updated region once.                 | Following tall message lists from top to bottom.                    |
| Marching perimeter   | A moving dashed perimeter marks an active delivery, then settles.               | Separating fresh activity from quiet retained marks.                |
| Echo rings           | Three close contour rings disperse around the changed component.                | Seeing the footprint of isolated updates without a fill.            |
| Heat memory          | Regions warm from blue to amber as their observed update count rises.           | Finding repeatedly updated components during a burst.               |
| Delivery stamps      | A compact numbered receipt tags each component with its delivery and hit count. | Comparing which regions were marked in the same delivery.           |
| Measurement brackets | Dimension guides label the actual width and height of changed regions.          | Finding unexpectedly large render footprints.                       |
| Thread map           | Curves connect a labeled listener origin to the regions Flow actually marked.   | Understanding one delivery followed by several component updates.   |
| History trail        | Numbered footprints connect the last five observed deliveries across the page.  | Following a burst through messages, presence, typing, and receipts. |
| Render mini-map      | A small spatial map shows the observed regions and highlights their updates.    | Seeing scattered updates together while inspecting a dense page.    |

## Verification

With the example running:

```sh
node examples/runtime-flow-lab/verify.mjs
node examples/runtime-flow-lab/verify-selection.mjs
node examples/runtime-flow-lab/verify-scroll.mjs
bunx --no-install tsc -p examples/runtime-flow-lab/tsconfig.json
```

The browser check covers specific component updates, one delivery updating multiple regions, idle-time delivery, all fifteen styles, a burst, narrow-screen overflow, reduced motion, and inspector toggling. Screenshots are written to `/tmp/flow-lab-review` by default; override `FLOW_LAB_SCREENSHOTS` and `FLOW_LAB_URL` as needed.

The selection check delays configuration and module loading, switches through both the page and chip selectors, and verifies actual outline CSS and decoration cleanup when returning from every treatment to Crisp outline.

The scroll check exercises native CSS anchors and a forced measured fallback across all fifteen treatments: document and nested scrolling, layout changes, resizing, removed photos, and restoration of application anchor names.

## Configure the chip in any supported host

Extend the existing project-root `pyric.json`; no Vite configuration is required:

```json
{
  "flow": {
    "treatment": "corners",
    "treatments": [
      {
        "id": "team:quiet",
        "label": "Quiet outline",
        "description": "A subtle outline for dense pages.",
        "module": "./flow-treatments/quiet.ts"
      }
    ]
  }
}
```

The fifteen built-ins ship with Pyric. Their metadata is available with the chip; selecting a treatment imports its packaged implementation. Custom modules are bundled for the browser on demand by the shared sandbox host. Module paths resolve from the project root; restart the host after changing the registrations. A failed module can be fixed and retried in the chip without changing the project config.

The Listeners tab has Overview / Flow controls and a Treatment selector in Flow mode. Changing it restyles current marks without generating a delivery or changing listener visibility. Choices are grouped into Standard, Experimental, and Custom. The browser remembers its choice under `pyric:flow-treatment`. Precedence is built-in default (`outline`), `pyric.json`, explicit Vite `flow` overrides when used, then the saved browser choice. An unavailable saved ID falls back to the project default, then `outline`. Hostless builds retain the packaged built-ins; custom modules require the shared host. Next.js consumes that host through its existing `/__pyric` rewrites.

Create `flow-treatments/quiet.ts` in the consuming app:

```ts
import type { FlowTreatment } from "@pyric/cli/flow";

export default {
  css: `
    html[data-pyric-treatment="team:quiet"] [data-pyric-flow] {
      outline: 1px solid var(--pyric-overlay-hue);
      outline-offset: 2px;
    }
    html[data-pyric-treatment="team:quiet"] [data-pyric-flow-retained] {
      outline-color: color-mix(in srgb, var(--pyric-overlay-hue) 30%, transparent);
    }
  `,
} satisfies FlowTreatment;
```

A module exports `{ css, mount? }`. Scope styles to its treatment ID. The existing runtime handles ordinary labels and detached photo/input labels; customize `[data-pyric-flow-badge]` separately when changing label appearance. These modules execute as application code in the browser. Keep server-only imports out of them.

For vector annotations, `mount({ document, container, history })` returns `{ update, dispose }`. Mount nodes in `container`, read the last five observed paints from `history()`, update geometry in `update`, and release owned resources in `dispose`. The runtime calls `update` after paints and shared geometry changes, including captured nested scrolling. It disposes the previous treatment when switching or disabling Flow. Existing marks carry `data-pyric-flow-hits`, `data-pyric-flow-sequence`, `data-pyric-flow-name`, and `data-pyric-flow-size`; detached badges receive those fields too. Counts describe observed paints, not CPU cost or proven dependencies.

Thread map uses a labeled listener origin because an incoming delivery may have no corresponding on-page button. The mini-map represents observed regions rather than requiring application-specific component attributes.

## Real SDK reads and listeners

The separate SDK example runs actual Firestore and Realtime Database calls through the same Flow runtime:

```sh
bun run build
bun examples/runtime-flow-lab/sdk-server.mts
```

Open [the in-page sandbox](http://localhost:5198/?runtime=inpage) or [the SharedWorker bridge](http://localhost:5198/?runtime=worker). Use the three read buttons, start listeners, then write the next version. All results update the same React component. **Read without rendering** and **Read denied path** exercise activity without a visual association. This example uses local seeded data and permissive example rules; it does not contact a Firebase project.

The chip records each read separately and each listener registration separately. Successful reads count once even if the value is unchanged. Completed records remain visible for up to 30 seconds; after the render-correlation window, the oldest terminal records are evicted when more than 100 are retained. Active registrations remain until stopped. Flow describes an observed render after delivery, not proven data lineage. Keep Flow enabled while exercising the example to observe commits.

### Check a query's local index configuration

In either SDK runtime, choose **Read sorted projects** to read draft projects ordered by budget. Open the chip's **Data** tab and select the `projects` query; its index details also appear in the matching **Traffic** request.

The example's `firebase.json` points to `firestore.indexes.json`, initially containing no composite indexes. The query shows **Missing from config**. The proposed fields appear automatically, with an optional **JSON definition** and a copy icon beside the definition. Choose **Add index** in the fixed footer to append the index to that local file. The status becomes **Configured**. Opening details never writes a file. If the file changes before saving, the chip refreshes the proposal and asks you to review it before adding.

The same flow in a supported local host uses the project-relative `firestore.indexes` path in its `firebase.json`. A standalone page without that connection shows **Check unavailable** and offers the definition’s copy icon when the query has a supported composite definition. Copying does not write a file.

These findings compare captured query fields with local configuration; they do not contact Firebase, deploy indexes, or prove a deployed index is ready. Analysis supports equality filters, sorting, and bounded range or array queries. OR, `in`, `not-in`, `!=`, `array-contains-any`, multiple range fields, combined range/array filters, document-ID queries, and escaped field paths remain unavailable. Single-field exemptions and unsupported shapes require review rather than an automatic composite addition.

Run the actual SDK browser checks from the repository root:

```sh
E2E_BASE=http://127.0.0.1:5198 bunx --no-install playwright test sdk-flow.pw.ts --config packages/cli/test/e2e/playwright.config.ts
```

The test starts its own example server on an available port and exercises both runtimes. `E2E_BASE` prevents the unrelated Studio server from starting. To run the example manually on another port, set `SDK_FLOW_PORT`.
