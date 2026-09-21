# Kin family space
<!-- impeccable:product-schema 1 -->
## Platform
web
## Purpose
A focused, private family social app. Parents curate a family feed and personalized feeds for their kids; there are no public followers or discovery feeds.
## Roles
Parents administer their family. Kids can create and change only their own posts and comments. Confirmed: parents must approve kid-created posts before they appear in feeds. Editing approved kid content requires renewed approval.
## Capabilities
Image, video, article, and event posts have cards and detail views. Kids can comment and opening a published detail records a view. Day/week/month schedules show accessible event posts. Shared family chat supports text, photos, video, and voice messages.
## Development
Firebase React app using the repository's Pyric Vite plugin and injected runtime chip. Real rules enforce membership, authorship, audience, and moderation. Seeded demo accounts use example-only email addresses. The app starts signed out. No developer impersonation controls in the app.
## Visual authority
The user supplied social-dashboards-mobile-figma file GiixTHg4blUrT4rqihJPKF. Preserve its white cards, pale canvas, vivid blue navigation, charcoal chat header, rounded media and compact typography; adapt subjects and navigation to families. Working app name Kin and fictional Parker family are implementation choices.

## Disposable family apps

Parents create focused React apps from a prompt, using a bounded snapshot of family members, published posts/feed, chat, and events. The selected recipients determine the intersection of kid-visible post context before generation. A draft stays private until its creator shares it; changing context or audience creates a new version.

Each app has its own Firestore records collection. Record authorization is intentionally high trust within the family: all family members may read/write/delete app records; nobody outside the family may access them. Selected recipients govern discovery and access to generated source/context, not per-record ownership. Generated code runs in a sandboxed iframe and uses a scoped data bridge rather than Firebase credentials. Normal app state is persisted; temporary UI state can remain local.

The Apps area is available through the main sidebar on desktop and the five-item bottom navigation on mobile. Parents get creation, sharing, versioning, and discard actions; kids open apps shared with them. Discard removes the app document and listing while retaining its records.


## App activity

A parent can navigate to feeds, chat, or the schedule while an app builds. Generation runs in a SharedWorker backed by @inbrowser/resumable and IndexedDB. Tabs reconnect to the same build after reload. If the worker is terminated, the next visit resumes from completed model output or restarts only the interrupted model request. Generation cannot run while the browser is closed. Signing out or switching identities explicitly cancels the activity; saving requires the original parent. Completed apps remain in Firestore.

The persistent progress bar links to App activity and shows the latest event. Expandable entries expose the selected family context, streamed React response, provider reasoning summaries when supplied, local compilation checks, validation errors and one repair attempt, Firestore save activity, and final results. Summaries are provider-supplied; compilation and save entries describe work performed by Kin. Stop build cancels result handling. When ready, the bar and activity view offer Open app; ready, failed, and stopped progress can be dismissed.

Generation uses Firebase AI Logic through Pyric's settings in an ignored `.env.local`. Live Gemini uses `PYRIC_AI_MODE=production` with `GEMINI_API_KEY`; local Ollama uses `PYRIC_AI_MODE=sandbox` with `PYRIC_AI_MODEL=ornith:9b`. Restart Vite after changes. Live generation sends the selected context to the configured provider; Firestore, Auth, and Storage remain sandboxed.
