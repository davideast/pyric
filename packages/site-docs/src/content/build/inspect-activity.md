---
title: "Inspect Firebase activity in your app"
navLabel: "Activity on the page"
group: "Build"
section: ""
order: 16
description: "Inspect SDK calls, deliveries, and observed renders from the runtime chip."
---

# Inspect Firebase activity in your app

Open the runtime chip's **Data** tab to see Firestore and Realtime Database reads and subscriptions. Repeated reads and subscriptions are grouped by source. Select a source to inspect its recent calls and updates, then use **Data** breadcrumb to return. The display controls stay in the footer.

**Overview** outlines registered regions and the latest observed regions for SDK activity. **Flow** highlights supported renders observed after a delivery. While Flow is running, Alt-click a highlighted region to open its details. Keyboard users can select the corresponding chip row; Overview badges are also buttons.

## Read the counts

- **Calls** count SDK invocations, including separate registrations of the same subscription.
- **Deliveries** count successful read results and public listener callbacks, including equal results. A failed read has no successful delivery.
- **Renders** count distinct observed renders. Several deliveries can precede one commit, and that commit can affect several regions. Changing treatments or inspecting history does not add a render.

Counts cover the **retained history** since the view started or was cleared; they do not fall to zero after a timed window. Source details group calls by app and source identity, including query shape. Each read has one row combining its result and render outcome. Subscription updates appear separately with a readable subscription number. Expanded reads show response time; shared render candidates appear only when present. Internal identifiers are not displayed. Row delivery counts cover the invocation's lifetime and do not reset when history is cleared.

These are observed SDK events, not server round trips or billable reads. An associated region **rendered after** a delivery; this does not prove that every value in the region came from that source. Details list other retained candidates observed in a shared commit. “No associated visual update” does not mean the result was unused. Render observation runs while Overview or Flow is on and requires supported React instrumentation.

## Inspect recent events

Recent calls and updates appear inside source details, not as a second feed on the Data list. The underlying history holds up to **100 metadata events**, projected into paged occurrence rows. One visible row can combine several events. **View traffic** opens Traffic filtered by service and path; this filter does not distinguish apps or query shapes. When older events are discarded, the chip says so and labels the counts as potentially incomplete.

Select a historical event to inspect it and highlight surviving observed regions. This uses the original element references, not selectors that might now identify replacement elements. It does not restore old DOM or replay application state. Historical inspection retains at most 100 region references per observed event.

**Clear** resets all recent history and its recent counts. It does not unsubscribe listeners or cancel SDK calls. Reload also resets history. Completed activities leave the live list after its short retention window, while retained history remains inspectable until cleared or evicted.

History excludes payloads, authentication tokens, and message bodies. Display targets strip URL credentials, query strings, and fragments; application-defined path segments can still contain information from your data model.

Denied requests can show an eight-second marker while Overview or Flow is enabled. The marker uses a captured owner when available, otherwise a previously observed region for an unambiguous matching service and path. The latter is labeled **related region**: it does not prove which component initiated the request. Click the marker to inspect that exact Traffic request. Requests without a reliable region remain in Traffic without a page marker.
