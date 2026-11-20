#!/usr/bin/env bash
set -euo pipefail

# Signal Handling & Cleanup Trap
GRADLE_LOG=""
cleanup() {
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
  echo "Runs the Kotlin Auth conformance test suite via Gradle Wrapper and exports JUnit XML."
  echo "Defaults:"
  echo "  suite_path: packages/kt-client/src/test/kotlin/dev/pyric/auth/ConformanceTest.kt"
  echo "  xml_output_path: .conformance/results/auth-kotlin.xml"
  exit 0
fi

# 1. Resolve Toolchain & Environment
JAVA_BIN=""
if [[ -n "${JAVA_HOME:-}" ]]; then
  if [[ ! -d "$JAVA_HOME" ]]; then
    echo "Error: Specified JAVA_HOME directory does not exist: $JAVA_HOME" >&2
    exit 1
  fi
  JAVA_BIN="$JAVA_HOME/bin/java"
elif command -v java >/dev/null 2>&1; then
  JAVA_BIN="$(command -v java)"
  RESOLVED_JAVA="$(readlink -f "$JAVA_BIN" 2>/dev/null || python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$JAVA_BIN")"
  CANDIDATE_HOME="$(dirname "$(dirname "$RESOLVED_JAVA")")"
  if [[ -d "$CANDIDATE_HOME" ]]; then
    export JAVA_HOME="$CANDIDATE_HOME"
  fi
else
  for candidate in \
    "/usr/lib/jvm/java-21-openjdk-amd64" \
    "/usr/lib/jvm/java-25-openjdk-amd64" \
    "${HOME:-}/.jdk"; do
    if [[ -n "$candidate" && -x "$candidate/bin/java" ]]; then
      export JAVA_HOME="$candidate"
      JAVA_BIN="$candidate/bin/java"
      break
    fi
  done
fi

if [[ -z "$JAVA_BIN" || ! -x "$JAVA_BIN" ]]; then
  echo "Error: Java executable not found on PATH or under JAVA_HOME." >&2
  exit 1
fi

JAVA_VERSION_OUTPUT="$("$JAVA_BIN" -version 2>&1 || true)"
if ! echo "$JAVA_VERSION_OUTPUT" | grep -Eq 'version "(21|25|27)([."]|$)'; then
  echo "Error: Kotlin conformance requires JDK 21, 25, or 27, but found incompatible version:" >&2
  echo "$JAVA_VERSION_OUTPUT" >&2
  exit 1
fi
if [[ -n "${JAVA_HOME:-}" ]]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi

# Optional Android SDK toolchain integration
if [[ -z "${ANDROID_HOME:-}" ]]; then
  if [[ -n "${ANDROID_SDK_ROOT:-}" && -d "$ANDROID_SDK_ROOT" ]]; then
    export ANDROID_HOME="$ANDROID_SDK_ROOT"
  elif [[ -n "${HOME:-}" && -d "$HOME/Library/Android/sdk" ]]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
  elif [[ -n "${HOME:-}" && -d "$HOME/Android/Sdk" ]]; then
    export ANDROID_HOME="$HOME/Android/Sdk"
  fi
fi

# Default bridge URL if needed by test environment
export PYRIC_BRIDGE_URL="${PYRIC_BRIDGE_URL:-ws://127.0.0.1:5174/__pyric/sandbox}"

# 2. Resolve Suite and Output Paths
SUITE="${1:-packages/kt-client/src/test/kotlin/dev/pyric/auth/ConformanceTest.kt}"
XML_OUT="${2:-$ROOT/.conformance/results/auth-kotlin.xml}"

if [[ "$SUITE" != /* ]]; then
  SUITE="$PWD/$SUITE"
fi

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
TEST_CLASS="dev.pyric.auth.ConformanceTest"
if [[ "$SUITE" =~ src/test/kotlin/(.+)\.kt$ ]]; then
  TEST_CLASS="${BASH_REMATCH[1]//\//.}"
fi

# 6. Execute Gradle Test Suite
GRADLE_LOG=$(mktemp)

GRADLE_EXIT=0
if [[ -z "${PYRIC_CLIMB:-}" && -t 1 ]]; then
  "$GRADLEW" -p "$KT_CLIENT_DIR" :cleanTest :test --tests "$TEST_CLASS" --no-daemon 2>&1 | tee "$GRADLE_LOG" || GRADLE_EXIT=$?
else
  "$GRADLEW" -p "$KT_CLIENT_DIR" :cleanTest :test --tests "$TEST_CLASS" --no-daemon > "$GRADLE_LOG" 2>&1 || GRADLE_EXIT=$?
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
  echo "Error: Kotlin Auth conformance run failed to produce $XML_OUT (gradle exit code: $GRADLE_EXIT)" >&2
  if [[ -n "${GRADLE_LOG:-}" && -f "$GRADLE_LOG" ]]; then
    tail -n 35 "$GRADLE_LOG" >&2
  fi
  FAIL_EXIT="${GRADLE_EXIT:-1}"
  if [[ "$FAIL_EXIT" -eq 0 ]]; then
    FAIL_EXIT=1
  fi
  exit "$FAIL_EXIT"
fi
