#!/usr/bin/env bash
# Runs the generated Kotlin projects (Ktor) in a clean container: Gradle compiles them and runs their own tests.
# Gradle downloads are cached in a Docker volume between runs.
#
# Usage: verification/runners/kotlin.sh <scenario-folder>...
# With DOCKER_NETWORK and TEST_DATABASE_JDBC_URL set (see with-database.sh), the tests run on that database.
# Exit status: 0 when every project passes, 1 otherwise.
set -u

IMAGE="gradle:9.8.2-jdk21"
status=0
for folder in "$@"; do
  name="$(basename "$folder")"
  echo "== $name"
  if docker run --rm \
    ${DOCKER_NETWORK:+--network "$DOCKER_NETWORK"} \
    ${TEST_DATABASE_JDBC_URL:+-e TEST_DATABASE_URL="$TEST_DATABASE_JDBC_URL"} \
    ${TEST_DATABASE_USER:+-e TEST_DATABASE_USER="$TEST_DATABASE_USER"} \
    ${TEST_DATABASE_PASSWORD:+-e TEST_DATABASE_PASSWORD="$TEST_DATABASE_PASSWORD"} \
    -e GRADLE_USER_HOME=/gradle-cache \
    -v "$(cd "$folder" && pwd)":/project:ro \
    -v model2api-gradle-cache:/gradle-cache \
    "$IMAGE" sh -c '
      set -e
      cp -r /project /work && cd /work
      gradle test --no-daemon --quiet --console=plain
      # How many tests ran, so a run without tests does not look like a pass
      grep -ho "tests=.[0-9]*" build/test-results/test/*.xml | tr -dc "0-9\n" | awk "{ total += \$1 } END { print \"tests: \" total }"
    '; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    status=1
  fi
done
exit $status
