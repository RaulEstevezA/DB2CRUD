#!/usr/bin/env bash
# Runs the generated Swift projects (Vapor) in a clean container: the Swift Package Manager builds them, fails on any
# warning of the project's own code, and runs their own tests. Packages and compiled dependencies are cached in a
# Docker volume between runs, so each project only compiles its own code.
#
# Usage: verification/runners/swift.sh <scenario-folder>...
# With DOCKER_NETWORK and TEST_DATABASE_NODE_URL set (see with-database.sh), the tests run on that database.
# Exit status: 0 when every project passes, 1 otherwise.
set -u

IMAGE="swift:6.4.2-noble"
status=0
for folder in "$@"; do
  name="$(basename "$folder")"
  echo "== $name"
  if docker run --rm \
    ${DOCKER_NETWORK:+--network "$DOCKER_NETWORK"} \
    ${TEST_DATABASE_NODE_URL:+-e TEST_DATABASE_URL="$TEST_DATABASE_NODE_URL"} \
    -v "$(cd "$folder" && pwd)":/project:ro \
    -v model2api-swift-cache:/cache \
    "$IMAGE" bash -c '
      set -eo pipefail
      cp -r /project /work && cd /work
      paths="--cache-path /cache/swiftpm --scratch-path /cache/build"
      swift build --build-tests $paths > /tmp/build.log 2>&1 || { grep -E "error:" /tmp/build.log | head -40; exit 1; }
      # A warning of the project itself fails the run; the dependencies are not ours to fix
      if grep -E "^/work/(Sources|Tests)/.*warning:" /tmp/build.log; then exit 1; fi
      swift test --skip-build $paths 2>&1 | tee /tmp/test.log | grep -E "✘|Expectation failed|error:|Test run" || true
      grep -q "✔ Test run with" /tmp/test.log
      # How many tests ran, so a run without tests does not look like a pass
      grep -o "Test run with [0-9]* test" /tmp/test.log | tr -dc "0-9\n" | sed "s/^/tests: /"
    '; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    status=1
  fi
done
exit $status
