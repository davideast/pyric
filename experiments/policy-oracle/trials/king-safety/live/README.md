# Production write observations

Each full release receives the same seven authenticated SDK move proposals from the [frozen positions](../reference/positions.json). Both colors are exercised from the matching seat. Black's writer sits in the guest seat. All matches begin playing at ply 16. The independent observer reads the complete document before and after each proposal. The controller compares the SDK fields against the server fields and records the original and final server versions.

The capture accepts either hosted outcome. For an allowed write it verifies the complete proposed successor and a newer version. For a refused write it verifies an identical document, creation time and update time. Neither the capture nor receipt admission requires the hosted answer to match native chess. The public score compares normalized proposals across releases so a different legal or illegal update cannot accidentally become the control. The [native answers](../reference/native.json) are a separate scoring input.

Only exact rulesets in the [release manifest](releases.json) are admitted to this isolated database. Each capture takes an exclusive lease, verifies the initial deny-all rules, and records propagation controls and the active digest. It restores the original release and verifies signed read and write refusal before releasing the lease. Successful captures are checked against the private controller journal before anonymized full snapshots are retained in this directory.

With the trial as working directory, replay both released rulesets and verify the public digests and snapshots with:

```sh
bun live/run.mjs replay "$generated_rules" "$installed_reference_package" -
```

An absolute private archive path in the final argument also reauthenticates the controller journals. The score reports Firestore's observed decision and the independent simulator's verdict and expression cost. Firestore supplies no expression count.
