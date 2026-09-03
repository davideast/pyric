#!/usr/bin/env bash
set -euo pipefail

# Root of the repository
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: $0 [suite_path] [xml_output_path]"
  echo "Runs the Flutter conformance test suite inside an isolated ARM64 Docker container."
  echo "Defaults:"
  echo "  suite_path: packages/flutter-client/test/conformance_test.dart"
  echo "  xml_output_path: .conformance/results/firestore-flutter.xml"
  exit 0
fi

SUITE="${1:-packages/flutter-client/test/conformance_test.dart}"
XML_OUT="${2:-$ROOT/.conformance/results/firestore-flutter.xml}"

# Resolve relative SUITE paths against $PWD before translating to /workspace/...
if [[ "$SUITE" != /* ]]; then
  SUITE="$PWD/$SUITE"
fi
if [[ "$SUITE" == "$ROOT/"* ]]; then
  SUITE="${SUITE#$ROOT/}"
fi
if [[ "$SUITE" == "/workspace/"* ]]; then
  SUITE="${SUITE#/workspace/}"
fi

# Ensure XML_OUT is an absolute path
if [[ "$XML_OUT" != /* ]]; then
  XML_OUT="$PWD/$XML_OUT"
fi

mkdir -p "$(dirname "$XML_OUT")"
XML_DIR="$(cd "$(dirname "$XML_OUT")" && pwd -P)"
XML_NAME="$(basename "$XML_OUT")"

# Delete stale XML output before running
rm -f "$XML_OUT" "$XML_DIR/$XML_NAME"

if command -v container >/dev/null 2>&1; then
  # Apple Container CLI (https://github.com/apple/container)
  CONTAINER_EXIT=0
  container run --rm \
    -v "$ROOT:/workspace" \
    -v "$XML_DIR:/out" \
    -w /workspace/packages/flutter-client \
    ghcr.io/cirruslabs/flutter:stable \
    bash -c '
      set -eo pipefail
      HOST_IP=$(ip route 2>/dev/null | awk "/default/ { print \$3 }" || echo "192.168.64.1")
      export PYRIC_BRIDGE_URL="${PYRIC_BRIDGE_URL:-ws://${HOST_IP}:5174/__pyric/sandbox}"
      flutter pub get >/dev/null 2>&1 || true
      (flutter test --reporter=json "/workspace/$1" 2>&1 || true) | dart run tool/json_to_junit.dart > /tmp/out.xml && mv /tmp/out.xml "/out/$2"
    ' _ "$SUITE" "$XML_NAME" || CONTAINER_EXIT=$?

  if [ -s "$XML_DIR/$XML_NAME" ]; then
    exit 0
  else
    echo "Error: Apple Container run failed to produce $XML_OUT (exit code: $CONTAINER_EXIT)" >&2
    exit 1
  fi
elif command -v docker >/dev/null 2>&1; then
  # Standard Docker CLI fallback
  DOCKER_EXIT=0
  docker run --rm \
    --add-host=host.docker.internal:host-gateway \
    -v "$ROOT:/workspace" \
    -v "$XML_DIR:/out" \
    -w /workspace/packages/flutter-client \
    ghcr.io/cirruslabs/flutter:stable \
    bash -c '
      set -eo pipefail
      export PYRIC_BRIDGE_URL="${PYRIC_BRIDGE_URL:-ws://host.docker.internal:5174/__pyric/sandbox}"
      flutter pub get >/dev/null 2>&1 || true
      (flutter test --reporter=json "/workspace/$1" 2>&1 || true) | dart run tool/json_to_junit.dart > /tmp/out.xml && mv /tmp/out.xml "/out/$2"
    ' _ "$SUITE" "$XML_NAME" || DOCKER_EXIT=$?

  if [ -s "$XML_DIR/$XML_NAME" ]; then
    exit 0
  else
    echo "Error: Docker run failed to produce $XML_OUT (exit code: $DOCKER_EXIT)" >&2
    exit 1
  fi
elif command -v flutter >/dev/null 2>&1 && command -v dart >/dev/null 2>&1; then
  # Fallback to host Flutter & Dart
  HOST_SUITE="$SUITE"
  if [[ "$HOST_SUITE" == "packages/flutter-client/"* ]]; then
    HOST_SUITE="${HOST_SUITE#packages/flutter-client/}"
  fi
  cd "$ROOT/packages/flutter-client"
  flutter pub get >/dev/null 2>&1 || true
  (flutter test --reporter=json "$HOST_SUITE" 2>&1 || true) | dart run tool/json_to_junit.dart > "$XML_DIR/$XML_NAME"

  if [ -s "$XML_DIR/$XML_NAME" ]; then
    exit 0
  else
    echo "Error: Host conformance run failed to produce $XML_OUT" >&2
    exit 1
  fi
else
  echo "Error: Apple Container ('container' CLI) is not available and neither flutter nor dart are installed on host." >&2
  echo "Install Apple Container from https://github.com/apple/container and run 'container system start'." >&2
  exit 1
fi
