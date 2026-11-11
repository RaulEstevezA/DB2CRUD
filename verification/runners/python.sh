#!/usr/bin/env bash
# Runs the generated Python projects (FastAPI, Django REST Framework) in a clean container: installs their
# dependencies, compiles every module and runs their own tests. Pip downloads are cached in a Docker
# volume between runs.
#
# Usage: verification/runners/python.sh <scenario-folder>...
# With DOCKER_NETWORK and TEST_DATABASE_URL set (see with-database.sh), the tests run on that database
# (Django gets the plain URL of TEST_DATABASE_NODE_URL).
# Exit status: 0 when every project passes, 1 otherwise.
set -u

IMAGE="python:3.12-slim"
status=0
for folder in "$@"; do
  name="$(basename "$folder")"
  echo "== $name"
  if docker run --rm \
    ${DOCKER_NETWORK:+--network "$DOCKER_NETWORK"} \
    ${TEST_DATABASE_URL:+-e TEST_DATABASE_URL="$TEST_DATABASE_URL"} \
    ${TEST_DATABASE_NODE_URL:+-e TEST_DATABASE_PLAIN_URL="$TEST_DATABASE_NODE_URL"} \
    -v "$(cd "$folder" && pwd)":/project:ro \
    -v model2api-pip-cache:/root/.cache/pip \
    "$IMAGE" sh -c '
      set -e
      cp -r /project /work && cd /work
      pip install --quiet --disable-pip-version-check --root-user-action=ignore -r requirements-dev.txt
      python -m compileall -q .
      # Django projects run their own test runner; the others, pytest
      # Django reads plain database URLs (postgres://, mysql://), SQLAlchemy names its driver
      if [ -f manage.py ]; then TEST_DATABASE_URL="${TEST_DATABASE_PLAIN_URL:-}" python manage.py test --verbosity 1; else python -m pytest -q -p no:cacheprovider; fi
    '; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    status=1
  fi
done
exit $status
