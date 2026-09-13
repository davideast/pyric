# Runtime Flow studies

A working chat example for comparing **five standard** and **ten experimental** Flow treatments. The chat uses separate subscriptions for messages, presence, typing, and read receipts. Messages also update the unread badge; presence updates both the header and member list.

Run from the repository root after installing the workspace dependencies:

```sh
bun examples/runtime-flow-lab/serve.ts
```

Open [the example](http://localhost:5197). Set `FLOW_LAB_PORT` to choose another port. Restart the server after editing TypeScript; CSS and HTML are read on each request.

Choose a treatment, then use **New message**, **Presence**, **Typing**, **Read receipt**, or **Run a burst**. Choosing a treatment repeats the last delivery so you can compare it immediately. **Clear marks & history** clears visual history while preserving the chat data. **Inspector** opens or minimizes the actual runtime chip.

All deliveries and user records are fixture data. The React renderer, commit hook, listener folding, and Flow painter are the real implementation. A render after a delivery is correlation, not proof that particular data reached every marked component. Experimental CSS and measured vector annotations belong only to this example, not the public runtime theme API.

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
| Thread map           | Curves connect the triggering control to the regions Flow actually marked.      | Understanding one delivery followed by several component updates.   |
| History trail        | Numbered footprints connect the last five observed deliveries across the page.  | Following a burst through messages, presence, typing, and receipts. |
| Render mini-map      | A small spatial map mirrors the chat and highlights its marked regions.         | Seeing scattered updates together while inspecting a dense page.    |

## Verification

With the example running:

```sh
node examples/runtime-flow-lab/verify.mjs
node examples/runtime-flow-lab/verify-scroll.mjs
bunx --no-install tsc -p examples/runtime-flow-lab/tsconfig.json
```

The browser check covers specific component updates, one delivery updating multiple regions, idle-time delivery, all fifteen styles, a burst, narrow-screen overflow, reduced motion, and inspector toggling. Screenshots are written to `/tmp/flow-lab-review` by default; override `FLOW_LAB_SCREENSHOTS` and `FLOW_LAB_URL` as needed.

The scroll check exercises native CSS anchors and a forced measured fallback across all fifteen treatments: document and nested scrolling, layout changes, resizing, removed photos, and restoration of application anchor names.
