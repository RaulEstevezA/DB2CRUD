#!/usr/bin/env bash
# Runs the generated PHP projects (Laravel, Symfony) in a clean container: installs their dependencies with Composer,
# checks the syntax of every file and runs their own tests with PHPUnit. The image (PHP with the PostgreSQL
# and MySQL drivers, and Composer) is built once; Composer downloads are cached in a Docker volume.
#
# Usage: verification/runners/php.sh <scenario-folder>...
# With DOCKER_NETWORK and TEST_DATABASE_NODE_URL set (see with-database.sh), the tests run on that database.
# Exit status: 0 when every project passes, 1 otherwise.
set -u

IMAGE="model2api-php:8.5"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build --quiet -t "$IMAGE" - >/dev/null <<'DOCKERFILE' || exit 1
FROM php:8.5-cli
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
ADD --chmod=0755 https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions /usr/local/bin/
RUN install-php-extensions pdo_pgsql pdo_mysql zip
DOCKERFILE
fi

status=0
for folder in "$@"; do
  name="$(basename "$folder")"
  echo "== $name"
  if docker run --rm \
    ${DOCKER_NETWORK:+--network "$DOCKER_NETWORK"} \
    ${TEST_DATABASE_NODE_URL:+-e TEST_DATABASE_URL="$TEST_DATABASE_NODE_URL"} \
    -e COMPOSER_CACHE_DIR=/composer-cache \
    -v "$(cd "$folder" && pwd)":/project:ro \
    -v model2api-composer-cache:/composer-cache \
    "$IMAGE" sh -c '
      set -e
      cp -r /project /work && cd /work
      composer install --no-interaction --no-progress --quiet
      find . -path ./vendor -prune -o -name "*.php" -print0 | xargs -0 -n1 php -l >/dev/null
      vendor/bin/phpunit --colors=never
    '; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    status=1
  fi
done
exit $status
