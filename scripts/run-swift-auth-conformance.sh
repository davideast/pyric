#!/usr/bin/env bash
set -euo pipefail

# Root of the repository
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: $0 [suite_path] [xml_output_path]"
  echo "Runs the Swift Auth conformance test suite natively on macOS using Swift Testing & SPM."
  echo "Defaults:"
  echo "  suite_path: packages/swift-client/Tests/PyricAuthTests/AuthConformanceTests.swift"
  echo "  xml_output_path: .conformance/results/auth-swift.xml"
  exit 0
fi

SUITE="${1:-packages/swift-client/Tests/PyricAuthTests/AuthConformanceTests.swift}"
XML_OUT="${2:-$ROOT/.conformance/results/auth-swift.xml}"

# Ensure XML_OUT is an absolute path
if [[ "$XML_OUT" != /* ]]; then
  XML_OUT="$PWD/$XML_OUT"
fi

mkdir -p "$(dirname "$XML_OUT")"

# Remove stale XML output before running
SWIFT_TESTING_XML="${XML_OUT%.xml}-swift-testing.xml"
rm -f "$XML_OUT" "$SWIFT_TESTING_XML"

export PYRIC_BRIDGE_URL="${PYRIC_BRIDGE_URL:-ws://127.0.0.1:5174/__pyric/sandbox}"
export PYRIC_CLIMB="${PYRIC_CLIMB:-1}"

FILTER_ARG=()
if [[ -n "${SUITE:-}" ]]; then
  SUITE_BASE="$(basename "$SUITE")"
  SUITE_NAME="${SUITE_BASE%.swift}"
  if [[ -n "$SUITE_NAME" ]]; then
    FILTER_ARG=(--filter "$SUITE_NAME")
  fi
fi

# Execute swift test; allow test failure exit codes (red at birth)
SWIFT_EXIT=0
swift test --package-path "$ROOT/packages/swift-client" "${FILTER_ARG[@]}" --xunit-output "$XML_OUT" || SWIFT_EXIT=$?

# SPM Swift Testing outputs <prefix>-swift-testing.xml instead of <prefix>.xml
if [[ -f "$SWIFT_TESTING_XML" ]]; then
  mv "$SWIFT_TESTING_XML" "$XML_OUT"
fi

if [[ -s "$XML_OUT" ]]; then
  exit 0
else
  echo "Error: Swift Auth test run failed to produce $XML_OUT (exit code: $SWIFT_EXIT)" >&2
  exit 1
fi
