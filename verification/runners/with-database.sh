#!/usr/bin/env bash
# Starts a database in a container, runs a runner with TEST_DATABASE_URL pointing to it, and removes the
# database and its network afterwards, whatever the result.
#
# Usage: verification/runners/with-database.sh <postgresql|mysql|mariadb> <runner> <scenario-folder>...
# The URL uses the driver each language's generated project names in its .env.example (.NET: a connection string).
set -u

database="$1"
runner="$2"
shift 2
network="model2api-verify-$$"
container="model2api-db-$$"
password="verify-only"

case "$database" in
  postgresql)
    image="postgres:16-alpine"
    env=(-e POSTGRES_USER=api -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=api)
    ready=(pg_isready -U api -d api)
    url_python="postgresql+psycopg://api:$password@$container:5432/api"
    url_jdbc="jdbc:postgresql://$container:5432/api"
    url_node="postgresql://api:$password@$container:5432/api"
    url_dotnet="Host=$container;Port=5432;Database=api;Username=api;Password=$password"
    ;;
  mysql | mariadb)
    image=$([ "$database" = mysql ] && echo "mysql:8.4" || echo "mariadb:11")
    env=(-e MYSQL_USER=api -e MYSQL_PASSWORD="$password" -e MYSQL_DATABASE=api -e MYSQL_ROOT_PASSWORD="$password" -e MARIADB_ROOT_PASSWORD="$password")
    ready=(sh -c "mysqladmin ping -h 127.0.0.1 -u api -p$password --silent 2>/dev/null || mariadb-admin ping -h 127.0.0.1 -u api -p$password --silent")
    url_python="mysql+pymysql://api:$password@$container:3306/api"
    url_jdbc="jdbc:$database://$container:3306/api"
    url_node="mysql://api:$password@$container:3306/api"
    url_dotnet="Server=$container;Port=3306;Database=api;User ID=api;Password=$password"
    ;;
  *)
    echo "Unknown database: $database" >&2
    exit 2
    ;;
esac

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1
  docker network rm "$network" >/dev/null 2>&1
}
trap cleanup EXIT

docker network create "$network" >/dev/null
docker run -d --name "$container" --network "$network" "${env[@]}" "$image" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$container" "${ready[@]}" >/dev/null 2>&1; then break; fi
  sleep 2
done
# The server may accept pings before it accepts the application user
sleep 3
# Django creates a test_* database for its tests: the user may create databases in this throwaway server
if [ "$database" != postgresql ]; then
  docker exec "$container" sh -c "mysql -uroot -p$password -e \"GRANT ALL PRIVILEGES ON *.* TO 'api'@'%'; FLUSH PRIVILEGES;\" 2>/dev/null || mariadb -uroot -p$password -e \"GRANT ALL PRIVILEGES ON *.* TO 'api'@'%'; FLUSH PRIVILEGES;\"" >/dev/null 2>&1
fi

export DOCKER_NETWORK="$network"
export TEST_DATABASE_URL="$url_python"
export TEST_DATABASE_JDBC_URL="$url_jdbc"
export TEST_DATABASE_NODE_URL="$url_node"
export TEST_DATABASE_DOTNET_URL="$url_dotnet"
export TEST_DATABASE_USER="api"
export TEST_DATABASE_PASSWORD="$password"
"$runner" "$@"
