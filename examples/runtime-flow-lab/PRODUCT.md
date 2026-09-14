# Runtime Flow example

This is a local development example for comparing ways to visualize the components that render after a listener delivery. It extends the existing Pyric runtime preview; it uses the runtime treatment registry without defining a new product identity.

The audience is a developer inspecting rendering in their own application. The example should make a single affected region, one delivery followed by several updated components, and repeated deliveries easy to distinguish.

The user requested a better chat workspace plus exactly five clear standard treatments and ten unconventional but useful treatments. All fifteen must be selectable and exercised by the same live render path. Each has a use case and a stated limitation.

Chat data is seeded locally. Messages and read receipts use real Firestore SDK writes and subscriptions; presence and typing use real Realtime Database SDK writes and subscriptions. Traffic and rates observe those actual operations. Directory records remain fixtures. React commits, fiber inspection, listener folding, and the production Flow painter are real. Correlation is not a traced data dependency. Heat represents observed marks, not CPU cost; dimensions represent geometry, not render duration; sequence numbers represent observed deliveries. Sample portraits use Pyric's URL-backed avatar resolver and local cache.

Preserve the user's chosen Geist and Geist Mono fonts, dark Pyric surfaces, common alignment lines, and gap-only spacing. No margin or padding declarations. Keep controls in the page, reserve space for the inspector on wide screens, collapse it initially on narrow screens, and respect reduced motion.

The runtime registry owns all fifteen treatments, shared paint metadata, and geometric annotations. The chip selects built-in or configured custom treatments; this example consumes the same implementation.

The Messages selector also offers an RTDB adapter behind the same chat interface. RTDB mode seeds 30 messages and exposes listener shape, broad versus narrow scope, pagination, edits and deterministic resets. Value and child callbacks are compared as payload evidence, not billed downloads. Index experiments use a disposable server-owned configuration with a reset action. Firestore mode retains its original three-message Flow fixture and all 15 treatments.
