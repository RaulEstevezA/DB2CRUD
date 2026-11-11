#!/usr/bin/env bash
# Runs the generated TypeScript projects in a clean container: installs their
# dependencies, checks their types, builds them and runs their own tests. npm downloads are cached in a
# Docker volume between runs.
#
# Usage: verification/runners/node.sh <scenario-folder>...
# With DOCKER_NETWORK and TEST_DATABASE_NODE_URL set (see with-database.sh), the tests run on that database.
# Exit status: 0 when every project passes, 1 otherwise.
set -u

IMAGE="node:24-alpine"
status=0
for folder in "$@"; do
  name="$(basename "$folder")"
  echo "== $name"
  if docker run --rm \
    ${DOCKER_NETWORK:+--network "$DOCKER_NETWORK"} \
    ${TEST_DATABASE_NODE_URL:+-e TEST_DATABASE_URL="$TEST_DATABASE_NODE_URL"} \
    -v "$(cd "$folder" && pwd)":/project:ro \
    -v db2crud-npm-cache:/root/.npm \
    -e NPM_CONFIG_UPDATE_NOTIFIER=false -e NO_COLOR=1 \
    "$IMAGE" sh -c '
      set -e
      cp -r /project /work && cd /work
      npm install --no-audit --no-fund --loglevel=error
      npm run --silent typecheck
      npm run --silent build
      # Each project runs its own test command
      npm test --silent
    '; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    status=1
  fi
done
exit $status
