# Private experiment evidence

The public repository contains harness code, synthetic fixtures, tests and sanitized findings. Original captures live in a private Cloud Storage bucket. Removing them from the publishing commit avoids retaining personal addresses, client IPs, broad IAM reports and raw deployment metadata in Git history.

The [archive index](evidence/index.json) maps 38 capture/comparison/deployment bundles and one original harness-source bundle to private objects and SHA-256 hashes. It is an index, not the raw evidence. Public summaries are publication copies; their bytes are not covered by the original capture manifests.

## Access and verification

An authorized Google Cloud identity is required. Bucket access does not follow GitHub access. No credentials or signed links belong in this repository.

```sh
# Work outside the repository so private evidence cannot be staged accidentally.
mkdir -p /tmp/pyric-private-evidence
cd /tmp/pyric-private-evidence
gcloud storage cp --recursive gs://digame-mas-pyric-experiment-evidence/snapshots/2026-09-20-8eef78f3 ./
cd 2026-09-20-8eef78f3
shasum -a 256 -c index.sha256
```

Also verify that `index.json` has SHA-256 `ecc333bb33be9a7e0e69e177843b3e73d17b7ef125f0d38f4e10df02e95e366b`, pinned in the public index. Merely checking a checksum downloaded alongside an archive is not an independent integrity check.

Select an archive from the public index; verify its SHA-256 before extracting it into an empty directory. Archives retain their original repository-relative paths, so original manifests and source remain together. The private index records every constituent file's size and SHA-256. `verification.json` documents the initial read-back check: all 39 archives and 1,543 original files matched. Nothing was rewritten in the original private captures.

Where supported, run the existing experiment's `verify`/`replay` CLI against the extracted capture. Dependencies and built Pyric packages are external, as documented in the original manifests. Older captures can lack source snapshots or replay support; do not fabricate missing provenance. Current tests generate temporary evidence and do not require access to this bucket. The legacy replay regression uses an explicitly synthetic fixture around the original eight-case harness source.

## Future captures

Run captures outside Git or in the ignored experiment capture directories. Keep a reviewed findings summary in the repository; upload original artifacts privately and add their hashes to the index after downloading and verifying them. Ignore rules reduce accidental staging but do not replace review: `git add -f` bypasses them, and Markdown can still contain sensitive data.

Public access prevention and uniform bucket-level access were verified at upload. The bucket has seven-day soft-delete protection; existing project IAM still applies. No credentials were included, but older archives contain limited identity/IP data and broader project configuration. Treat them as private. Do not automatically expire the only copy of evidence referenced by published findings.

Historical commands in the findings that name `results/`, `records/`, `measurements/`, `comparisons/`, `analyses/` or `log-exports/` refer to private artifacts. Restore them outside Git before running those comparisons. Links to removed raw files now lead here; use the run IDs in the surrounding text and archive index to select the corresponding bundle.
