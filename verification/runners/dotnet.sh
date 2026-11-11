#!/usr/bin/env bash
# Runs the generated .NET projects (ASP.NET Core) in a clean container: the .NET SDK restores the packages,
# builds the solution and runs its own tests with xUnit. NuGet downloads are cached in a Docker volume.
#
# Usage: verification/runners/dotnet.sh <scenario-folder>...
# With DOCKER_NETWORK and TEST_DATABASE_DOTNET_URL set (see with-database.sh), the tests run on that database.
# Exit status: 0 when every project passes, 1 otherwise.
set -u

IMAGE="mcr.microsoft.com/dotnet/sdk:10.0"
status=0
for folder in "$@"; do
  name="$(basename "$folder")"
  echo "== $name"
  if docker run --rm \
    ${DOCKER_NETWORK:+--network "$DOCKER_NETWORK"} \
    ${TEST_DATABASE_DOTNET_URL:+-e TEST_DATABASE_CONNECTION="$TEST_DATABASE_DOTNET_URL"} \
    -e DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    -e DOTNET_NOLOGO=1 \
    -e NUGET_PACKAGES=/nuget \
    -v "$(cd "$folder" && pwd)":/project:ro \
    -v model2api-nuget-cache:/nuget \
    "$IMAGE" sh -c '
      set -e
      cp -r /project /work && cd /work
      dotnet test --nologo -v quiet
    '; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    status=1
  fi
done
exit $status
