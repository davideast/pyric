---
title: "Inspect Firebase activity in your app"
navLabel: "Activity on the page"
group: "Build"
section: ""
order: 16
description: "Inspect SDK calls, deliveries, and observed renders from the runtime chip."
---

# Inspect Firebase activity in your app

Open the runtime chip's **Listeners** tab to see Firestore and Realtime Database reads and subscriptions. Select a row to inspect its source, method, state, and recent activity. The display controls stay in the footer.

**Overview** outlines registered regions. **Flow** highlights supported renders observed after a delivery. While Flow is running, Alt-click a highlighted region to open its details. Keyboard users can select the corresponding chip row; Overview badges are also buttons.

## Read the counts

- **Calls** count SDK invocations, including separate registrations of the same subscription.
- **Deliveries** count successful read results and public listener callbacks, including equal results. A failed read has no successful delivery.
- **Associated commits** count distinct observed commits. Several deliveries can precede one commit, and that commit can affect several regions. Changing treatments or inspecting history does not add a commit.

The recent counts cover the **last 30 seconds of retained events** since the view started or was cleared. Source details group calls by app and source identity, including query shape. Each invocation remains individually identified in history. Row delivery counts cover the invocation's lifetime and do not reset when history is cleared.

These are observed SDK events, not server round trips or billable reads. An associated region **rendered after** a delivery; this does not prove that every value in the region came from that source. Details list other retained candidates observed in a shared commit. “No associated visual update” does not mean the result was unused. Render observation runs while Flow is on and requires supported React instrumentation.

## Inspect recent events

The history holds up to **100 metadata events**, with pagination. Selecting a live activity filters history to its source. When older events are discarded, the chip says so and labels the counts as potentially incomplete.

Select a historical event to inspect it and highlight surviving observed regions. This uses the original element references, not selectors that might now identify replacement elements. It does not restore old DOM or replay application state. Historical inspection retains at most 100 region references per observed event.

**Clear** resets this history and its recent counts. It does not unsubscribe listeners or cancel SDK calls. Reload also resets history. Completed activities leave the live list after its short retention window, while retained history remains inspectable until cleared or evicted.

History excludes payloads, authentication tokens, and message bodies. Display targets strip URL credentials, query strings, and fragments; application-defined path segments can still contain information from your data model.
