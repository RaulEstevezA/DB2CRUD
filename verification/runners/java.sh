#!/usr/bin/env bash
# Runs the generated Java projects (Spring Boot) in a clean container: Maven compiles them and runs their
# own tests. Maven downloads are cached in a Docker volume between runs.
#
# Usage: verification/runners/java.sh <scenario-folder>...
# With DOCKER_NETWORK and TEST_DATABASE_JDBC_URL set (see with-database.sh), the tests run on that database.
# Exit status: 0 when every project passes, 1 otherwise.
set -u

IMAGE="maven:3.9-eclipse-temurin-21"
status=0
for folder in "$@"; do
  name="$(basename "$folder")"
  echo "== $name"
  if docker run --rm \
    ${DOCKER_NETWORK:+--network "$DOCKER_NETWORK"} \
    ${TEST_DATABASE_JDBC_URL:+-e TEST_DATABASE_URL="$TEST_DATABASE_JDBC_URL"} \
    ${TEST_DATABASE_USER:+-e TEST_DATABASE_USER="$TEST_DATABASE_USER"} \
    ${TEST_DATABASE_PASSWORD:+-e TEST_DATABASE_PASSWORD="$TEST_DATABASE_PASSWORD"} \
    -v "$(cd "$folder" && pwd)":/project:ro \
    -v model2api-maven-cache:/root/.m2 \
    "$IMAGE" sh -c '
      set -e
      cp -r /project /work && cd /work
      mvn -q -B -ntp test
    '; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    status=1
  fi
done
exit $status
