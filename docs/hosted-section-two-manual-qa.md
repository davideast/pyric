# Section 2 manual checkpoint

Use a disposable project or a copy of your demo. The automated work leaves the
existing server and data on port 43110 untouched; restart that server from the
updated branch and reload both browsers once to load the matching SDK code.
Subsequent restart checks below deliberately keep those pages open. Mixed old/new
client versions belong to the later compatibility matrix.

1. Open hosted mode in two browsers. Sign in as different users under different
   tenants. Give one user an editor claim and the other a viewer claim; use Rules
   that restrict document ownership, tenant and editor writes. Check each user's
   own writes and cross-tenant denial.
2. In one browser, change the configured tenant without signing out. Its current
   user and token must retain the original tenant. Refresh its token, then sign
   out and sign into the other tenant. The second browser must keep its user,
   token claims and Rules access throughout.
3. Restart the hosted server on the same port without refreshing either browser.
   Both existing apps should recover. Repeat a permitted write and a denied
   cross-tenant write, then sign out in just one browser.
4. Leave a browser suspended or asleep for more than a minute while its host-side
   connection is lost. On return, the existing app should recover and receive
   each new update once. If a write was interrupted, inspect its stored result
   before manually retrying; recovery never promises to replay it.
5. Repeat the two-client identity check in default SharedWorker mode. For the
   in-page fallback, verify that sharing account records does not sign another
   tab in or out. Automated tests explicitly force this fallback before imports.

A real sleep test depends on OS/browser scheduling. The automated expiry test
independently pauses browser timers, closes the host connection, observes real
host expiry, and then delivers the delayed close. Manual verification is a
separate acceptance checkpoint; this document does not record a manual pass.

Section 3 covers RTDB disconnect behavior and concurrent data operations.
