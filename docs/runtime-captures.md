# Save and inspect runtime captures

In **Traffic → Rates**, open a service and select the interval you want to keep. Choose **More actions → Save capture…**. The local host writes a new snapshot under the project's `.pyric/captures/` and opens the capture list. Each save creates a distinct file, without replacing previous captures or `.pyric/last-session.json`.

Choose **More actions → Open capture…** to browse saved captures. A row identifies the service, recorded time, duration, and incident when present. Opening it shows the saved interval read-only. **Return to live** returns to the running page. Captures remain available after page reloads and host restarts.

In an opened capture, **More actions → Download JSON** saves a portable copy. In the capture list, **More actions → Open file…** opens a downloaded copy. Standalone pages without a connected project host use downloading when saving.

## Name or delete a capture

Open a saved capture, then choose **More actions → Rename…**. Enter a name of up to 80 characters and Save. Clearing the name returns to the service label. The name appears in the capture list and breadcrumb and is stored separately from the original evidence.

Choose **More actions → Delete…** to remove that snapshot. The confirmation screen offers Cancel or Delete. Deletion removes the capture and its name from project storage; it does not change the running sandbox or other captures.

## Inspect with sandbox tools

The `sandbox` service exposes:

| Method | Arguments | Result |
| --- | --- | --- |
| `saveCapture` | `capture`: runtime capture JSON string | Saved id, service, recorded time, duration, incident |
| `listCaptures` | None | Project captures, newest save first |
| `openCapture` | Optional `id`; omit for latest | Full investigation bundle |
| `renameCapture` | `id`, `name` | Updated listing entry; empty name clears it |
| `deleteCapture` | `id`, `confirm: true` | Removes the selected saved snapshot |

The browser bridge exposes the same operations as `sandbox_save_capture`, `sandbox_list_captures`, `sandbox_open_capture`, `sandbox_rename_capture`, and `sandbox_delete_capture`. File operations run on the local host in the attached project's directory. An agent can inspect a snapshot saved by the chip without uploading or downloading a file.

Saving requires capture JSON produced by the runtime; it does not reconstruct unrecorded measurements from current sandbox data. Opening does not seed data, restore rules, apply thresholds, or replay operations.

## Capture contents

The `pyric.rate-capture.v1` bundle contains chart measurements, the selected interval, threshold settings, selected incident details, and retained operations for that service and interval. When available, a separate session fixture contains state at save time. That attachment is not the starting state of the selected interval. The bundle is not directly a `pyric verify` input or an exact timed replay.

Captures are limited to 32 MB. Project storage accepts validated bundles under generated ids, publishes completed files without overwriting existing ones, and rejects paths or symbolic links that redirect capture access. The HTTP channel uses the local host and session capability checks. Captures contain the local data present in their fixture attachment; the normal `.pyric/` ignore rule keeps them out of commits.

## Hand a saved incident to an agent

Ask: “Inspect the latest saved Firestore capture. Explain which limit was exceeded, the peak rate, time above the limit, and which recorded operations contributed. Distinguish the selected interval from time above the limit, and state what the capture cannot establish about billing or replay.”

The agent can use `listCaptures` to select the newest entry for that service, then `openCapture` with its id. Newly saved captures include the same measurement definitions as the chip's **How measurements work** disclosure. The full-state attachment is optional; the incident and measurement evidence can be inspected without restoring it.

Storage captures use the same controls and sandbox methods. Their one-second points include reads, writes, deletes, and completed uploaded/downloaded bytes. Byte totals cover successful SDK transfers; they exclude external fetches of download URLs, partial transfers, retries, and protocol overhead. They are local observations, not billing totals.

## Storage results can be followed into React

In **Data**, enable a source’s highlight (or **Show all**) and select **Flow**. Storage results and upload progress can be associated with subsequent React commits. A highlight means a render was observed after the result or callback, not that Pyric proved a data dependency. Flow requires the React commit hook to be installed before the renderer loads.

The chat demo’s **Attachments** section uploads a 16 KiB image and downloads it into a React preview. Its upload progress and preview provide visible Flow targets. Upload progress is synthetic sandbox progress; it is recorded separately from completed results and never adds operations or transferred bytes to Rates. Writes, deletes, and metadata operations also appear in Data with their Storage action names.
