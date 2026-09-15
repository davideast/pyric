# Set runtime activity warnings

Open **Traffic → Rates → Firestore, Realtime Database, or Storage → More actions → Thresholds**. More actions is the three-dot menu in the bottom bar.

The limits measure activity on this page. Set a limit per second for each operation; the adjacent column shows its equivalent per minute if sustained. Leave a limit empty to turn that warning off. **Sustained for** sets the number of consecutive seconds required, for all services.

**Save** writes project settings to `pyric.json` through the connected local server. Cancel discards edits. Use defaults resets the displayed service and the shared duration in the draft; Save is still required. Without a project connection, the page labels settings **This session** and keeps them only until reload.

```json
{
  "runtime": {
    "thresholds": {
      "sustainedSeconds": 5,
      "firestore": {
        "documentReads": 20,
        "documentWrites": 5,
        "documentDeletes": 5
      },
      "rtdb": {
        "reads": 10,
        "writes": 5,
        "deliveries": 20
      },
      "storage": {
        "reads": 10,
        "writes": 5,
        "deletes": 5
      }
    }
  }
}
```

These are the defaults. Omitted settings use them without adding anything to the file. Set an individual limit to `null` to disable it. Limits must be positive finite numbers up to 1,000,000. The sustained duration must be a whole number from 1 to 60 seconds.

The defaults are investigation starting points, not Firebase quotas or recommended production capacity. Firestore counts estimated document reads, writes and deletes. RTDB counts SDK read/write requests (including failed attempts) and listener deliveries, including initial callbacks. Storage counts read, write, and delete calls, including failed attempts; deletes are separate from writes. Resumable uploads count once, not once per progress callback. Listener deliveries are not billed downloads. The service view's **How measurements work** section explains the coverage and omissions.

## Review an alert

Each completed one-second bucket must be strictly above the limit for the configured duration. A single spike, activity exactly at the limit, and the unfinished current second do not trigger a warning.

The chip turns amber when an alert needs review. A failed request still takes priority. Open the chip to reach Traffic's Rates view and select an alert to inspect its recorded chart interval. Amber bands mark periods that exceeded the configured duration and limit.

Recorded alerts retain the **Exceeded** badge after activity returns below the limit. Opening the alert acknowledges it and clears its contribution to the chip's warning. Continued activity in the same episode does not create duplicate alerts; a later episode can warn again.

The page retains up to 32 alerts in memory, each with up to 60 seconds of chart evidence. For an episode longer than a minute, the chart shows the latest retained minute while the alert keeps the episode's duration and peak. Reloading clears alerts. Changing a threshold applies to subsequent activity and ends existing episodes; it does not retroactively classify old activity.

Project edits made elsewhere are read when the page loads or Thresholds is reopened. A stale Save is rejected so it cannot overwrite a newer edit to `pyric.json`.

## Exercise warnings in the chat demo

Start `bun examples/runtime-flow-lab/serve.ts`, open `http://localhost:5197/`, and click **Test rate warning**. It sends real message writes about ten times per second for seven seconds on the selected backend. The default write limit is five per second sustained for five seconds. Switch Messages between Firestore and Realtime Database to test each service. The demo writes threshold settings to its disposable project directory rather than your application's configuration.

An incident remains open until five consecutive completed seconds are at or below its limit. A rise during those five seconds continues the same incident without requiring another trigger period. Before an incident first triggers, any second at or below the limit still resets the required consecutive sequence.

**Time above limit** counts only seconds exceeding the limit. **Elapsed time** spans the first through the last above-limit second, including brief gaps between bursts. The five quiet seconds used to confirm the end are excluded from elapsed time. Chart warning bands also exclude below-limit gaps. Recorded incidents keep the **Exceeded** badge after they end.

The demo’s **Attachments** controls exercise Storage independently of the chat backend: upload 16 KiB, download, delete, deny an upload, and run a Storage burst. The burst attempts ten uploads per second for eight seconds to exercise the default write warning.
