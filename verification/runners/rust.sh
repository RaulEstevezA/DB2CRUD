#!/usr/bin/env bash
# Runs the generated Rust projects (Axum) in a clean container: Cargo compiles them, with every compiler warning
# treated as an error, and runs their own tests. The Cargo registry and the compiled dependencies are cached in
# Docker volumes between runs, so each project only compiles its own code.
#
# Usage: verification/runners/rust.sh <scenario-folder>...
# With DOCKER_NETWORK and TEST_DATABASE_NODE_URL set (see with-database.sh), the tests run on that database.
# Exit status: 0 when every project passes, 1 otherwise.
set -u

IMAGE="rust:1.99.1"
status=0
for folder in "$@"; do
  name="$(basename "$folder")"
  echo "== $name"
  if docker run --rm \
    ${DOCKER_NETWORK:+--network "$DOCKER_NETWORK"} \
    ${TEST_DATABASE_NODE_URL:+-e TEST_DATABASE_URL="$TEST_DATABASE_NODE_URL"} \
    -e CARGO_HOME=/cargo-home \
    -e CARGO_TARGET_DIR=/cargo-target \
    -e RUSTFLAGS="-D warnings" \
    -e CARGO_TERM_COLOR=never \
    -v "$(cd "$folder" && pwd)":/project:ro \
    -v db2crud-cargo-home:/cargo-home \
    -v db2crud-cargo-target:/cargo-target \
    "$IMAGE" bash -c '
      set -eo pipefail
      cp -r /project /work && cd /work
      cargo test --quiet 2>&1 | tee /tmp/test.log
      # How many tests ran, so a run without tests does not look like a pass
      grep -o "[0-9]* passed" /tmp/test.log | awk "{ total += \$1 } END { print \"tests: \" total }"
    '; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    status=1
  fi
done
exit $status
