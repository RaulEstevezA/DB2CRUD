#!/usr/bin/env bash
# Generates every verification scenario and runs each project's own tests with its real tools, in Docker.
# Scenarios that need a database run with one (runners/with-database.sh).
#
# Usage: verification/run.sh [scenario-id-prefix]
# Exit status: 0 when every scenario passes. Then update web/src/core/settings/verified.ts.
set -u
cd "$(dirname "$0")"

node --experimental-strip-types --no-warnings generate.mjs "${1:-}" || exit 1

status=0
runner_of() {
  case "$1" in
    sqlalchemy-*) echo ./runners/python.sh ;;
  esac
}

for folder in .work/"${1:-}"*/; do
  name="$(basename "$folder")"
  runner="$(runner_of "$name")"
  service="$(node --input-type=module -e "import { SCENARIOS } from './scenarios/index.mjs'; console.log(SCENARIOS.find((s) => s.id === '$name')?.service ?? '')")"
  if [ -n "$service" ]; then
    ./runners/with-database.sh "$service" "$runner" "$folder" || status=1
  else
    "$runner" "$folder" || status=1
  fi
done
exit $status
