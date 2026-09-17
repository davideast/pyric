# Sourced by the packaging gate. Own only the smoke server's process group.
SERVE_PID=""

start_packaging_server() {
  local directory="$1"
  shift
  # A distinct job group lets teardown include launchers and their descendants.
  set -m
  ( cd "$directory" && exec "$@" ) > "$directory/serve.out" 2> "$directory/serve.err" &
  SERVE_PID=$!
  set +m
}

stop_packaging_server() {
  [ -n "$SERVE_PID" ] || return 0
  local owned_group="$SERVE_PID"
  SERVE_PID=""
  kill -TERM -- "-$owned_group" 2>/dev/null || true
  # Bound graceful shutdown, then stop any stubborn descendants in this group.
  for _ in $(seq 1 40); do
    kill -0 -- "-$owned_group" 2>/dev/null || break
    sleep 0.05
  done
  kill -KILL -- "-$owned_group" 2>/dev/null || true
  wait "$owned_group" 2>/dev/null || true
}

packaging_exit() {
  local status=$?
  trap - EXIT
  stop_packaging_server
  if [ "$status" -ne 0 ]; then
    echo ""
    echo "✗ packaging gate FAILED — work dir preserved for debugging:"
    echo "  $WORK"
  fi
  exit "$status"
}

trap packaging_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
