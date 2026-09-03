#!/usr/bin/env bash
set -euo pipefail

# Signal Handling & Cleanup Trap
GRADLE_LOG=""
cleanup() {
  local exit_code=$?
  if [[ -n "${GRADLE_LOG:-}" && -f "$GRADLE_LOG" ]]; then
    rm -f "$GRADLE_LOG"
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# Root of the repository
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
KT_CLIENT_DIR="$ROOT/packages/kt-client"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: $0 [suite_path] [xml_output_path]"
  echo "Runs the Kotlin Firestore conformance test suite via Gradle Wrapper and exports JUnit XML."
  echo "Defaults:"
  echo "  suite_path: packages/kt-client/src/test/kotlin/dev/pyric/firestore/ConformanceTest.kt"
  echo "  xml_output_path: .conformance/results/firestore-kotlin.xml"
  exit 0
fi

# 1. Resolve Toolchain & Environment
DEFAULT_JAVA_HOME="/Users/deast/.jdk/jdk-21.0.12.1+1/Contents/Home"
if [[ -n "${JAVA_HOME:-}" ]]; then
  if [[ ! -d "$JAVA_HOME" ]]; then
    echo "Error: Specified JAVA_HOME directory does not exist: $JAVA_HOME" >&2
    exit 1
  fi
  export JAVA_HOME="$JAVA_HOME"
elif [[ -d "$DEFAULT_JAVA_HOME" ]]; then
  export JAVA_HOME="$DEFAULT_JAVA_HOME"
else
  echo "Error: JAVA_HOME is not set and default JDK at $DEFAULT_JAVA_HOME does not exist." >&2
  exit 1
fi

JAVA_BIN="$JAVA_HOME/bin/java"
if [[ ! -x "$JAVA_BIN" ]]; then
  echo "Error: Java executable not found or not executable at $JAVA_BIN" >&2
  exit 1
fi

JAVA_VERSION_OUTPUT="$("$JAVA_BIN" -version 2>&1 || true)"
if ! echo "$JAVA_VERSION_OUTPUT" | grep -q 'version "21\.'; then
  echo "Error: Kotlin conformance requires JDK 21 LTS, but found incompatible version at $JAVA_HOME:" >&2
  echo "$JAVA_VERSION_OUTPUT" >&2
  exit 1
fi
export PATH="$JAVA_HOME/bin:$PATH"

# Optional Android SDK toolchain integration
DEFAULT_ANDROID_HOME="/Users/deast/Library/Android/sdk"
if [[ -d "$DEFAULT_ANDROID_HOME" && -z "${ANDROID_HOME:-}" ]]; then
  export ANDROID_HOME="$DEFAULT_ANDROID_HOME"
fi

# Default bridge URL if needed by test environment
export PYRIC_BRIDGE_URL="${PYRIC_BRIDGE_URL:-ws://127.0.0.1:5174/__pyric/sandbox}"

# 2. Resolve Suite and Output Paths
SUITE="${1:-packages/kt-client/src/test/kotlin/dev/pyric/firestore/ConformanceTest.kt}"
XML_OUT="${2:-$ROOT/.conformance/results/firestore-kotlin.xml}"

# Normalize SUITE to absolute path
if [[ "$SUITE" != /* ]]; then
  SUITE="$PWD/$SUITE"
fi

# Normalize XML_OUT to absolute path
if [[ "$XML_OUT" != /* ]]; then
  XML_OUT="$PWD/$XML_OUT"
fi

mkdir -p "$(dirname "$XML_OUT")"
XML_DIR="$(cd "$(dirname "$XML_OUT")" && pwd -P)"
XML_NAME="$(basename "$XML_OUT")"

# 3. Purge Stale Artifacts
rm -f "$XML_OUT" "$XML_DIR/$XML_NAME"

# 4. Verify Gradle Wrapper Presence
GRADLEW="$KT_CLIENT_DIR/gradlew"
if [[ ! -f "$GRADLEW" ]]; then
  echo "Error: Gradle wrapper not found at $GRADLEW" >&2
  exit 1
fi
if [[ ! -x "$GRADLEW" ]]; then
  chmod +x "$GRADLEW"
fi

# 5. Derive Test Class Filter
TEST_CLASS="dev.pyric.firestore.ConformanceTest"
if [[ "$SUITE" =~ src/test/kotlin/(.+)\.kt$ ]]; then
  TEST_CLASS="${BASH_REMATCH[1]//\//.}"
fi

# 6. Execute Gradle Test Suite
GRADLE_LOG=$(mktemp)

GRADLE_EXIT=0
if [[ -z "${PYRIC_CLIMB:-}" && -t 1 ]]; then
  # Interactive mode: stream to stdout while capturing log
  "$GRADLEW" -p "$KT_CLIENT_DIR" cleanTest test --tests "$TEST_CLASS" 2>&1 | tee "$GRADLE_LOG" || GRADLE_EXIT=$?
else
  # Automated / Climb Lane mode: quiet execution, capture full log
  "$GRADLEW" -p "$KT_CLIENT_DIR" cleanTest test --tests "$TEST_CLASS" > "$GRADLE_LOG" 2>&1 || GRADLE_EXIT=$?
fi

# 7. Locate and Copy JUnit XML Report
XML_SOURCE="$KT_CLIENT_DIR/build/test-results/test/TEST-${TEST_CLASS}.xml"
if [[ ! -f "$XML_SOURCE" ]]; then
  CLASS_SIMPLE_NAME="${TEST_CLASS##*.}"
  XML_SOURCE=$(find "$KT_CLIENT_DIR/build/test-results/test" -name "TEST-*${CLASS_SIMPLE_NAME}*.xml" 2>/dev/null | head -n 1 || true)
fi

if [[ -n "$XML_SOURCE" && -f "$XML_SOURCE" ]]; then
  cp "$XML_SOURCE" "$XML_OUT"
fi

# 8. Verification and Exit Contract
if [[ -s "$XML_OUT" ]]; then
  exit 0
else
  echo "Error: Kotlin conformance run failed to produce $XML_OUT (gradle exit code: $GRADLE_EXIT)" >&2
  if [[ -n "${GRADLE_LOG:-}" && -f "$GRADLE_LOG" ]]; then
    tail -n 35 "$GRADLE_LOG" >&2
  fi
  FAIL_EXIT="${GRADLE_EXIT:-1}"
  if [[ "$FAIL_EXIT" -eq 0 ]]; then
    FAIL_EXIT=1
  fi
  exit "$FAIL_EXIT"
fi
