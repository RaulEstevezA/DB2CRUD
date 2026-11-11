# Verification

Producing files is not proof that they work. Every stack Model2API offers has had a generated project built, run and called with its own tools, in Docker, by the scripts of `verification/`.

## What a run checks

For each scenario (a built-in example, a stack and some edits of the proposed design), `verification/generate.mjs` writes the project with the same core the web version runs. Then a runner, in a clean container:

| Runner | Image | Steps |
|---|---|---|
| `runners/python.sh` | `python:3.12-slim` | Installs `requirements-dev.txt`, compiles every module, runs the project's tests (pytest, or `manage.py test` for Django) |
| `runners/node.sh` | `node:24-alpine` | Installs the dependencies, checks the types (`tsc --noEmit`), builds, runs the project's tests (Vitest or Jest) |
| `runners/java.sh` | `maven:3.9-eclipse-temurin-21` | Compiles and runs the project's tests with Maven |
| `runners/php.sh` | `php:8.5-cli` with the PostgreSQL and MySQL drivers and Composer, built once | Installs the dependencies with Composer, checks the syntax of every file (`php -l`), runs the project's tests with PHPUnit |
| `runners/dotnet.sh` | `mcr.microsoft.com/dotnet/sdk:10.0` | Restores the packages, builds the solution and runs the project's tests with xUnit (`dotnet test`) |
| `runners/kotlin.sh` | `gradle:9.8.2-jdk21` | Compiles and runs the project's tests with Gradle, and prints how many ran |
| `runners/rust.sh` | `rust:1.99.1` | Compiles the project with every warning treated as an error and runs its tests with Cargo (registry and compiled dependencies cached in Docker volumes), and prints how many ran |
| `runners/swift.sh` | `swift:6.4.2-noble` | Builds the project and its tests with the Swift Package Manager, fails on any warning of the project's own code, runs its Swift Testing suites (packages and compiled dependencies cached in a Docker volume), and prints how many ran |

The tests are generated with the project: every enabled endpoint is called the way a client would (create and read back, list and paginate, replace, update part, delete, missing items, invalid bodies, null where it is not allowed, missing credentials, missing roles, business operations still to write).

Scenarios with a database run with one: `runners/with-database.sh` starts PostgreSQL 16, MySQL 8.4 or MariaDB 11 on a private network, passes its address to the runner and removes both afterwards.

## Running it

Requires Docker and Node.js 22.6 or later.

```bash
verification/run.sh                 # every scenario
verification/run.sh fastapi         # the scenarios whose id starts with "fastapi"
```

Downloads (pip, npm, Maven) are cached in Docker volumes, so later runs are faster. Generated projects are written to `verification/.work/`, which is not versioned.

## After a run

Add every scenario that passed to `web/src/core/compatibility/verified.ts`, with its date. That file is the record of what has run; it tells apart:

- **Verified**: this exact stack passed.
- **Verified by parts**: its storage and database, its architecture and its authentication each passed with this framework, but not together.
- **Not verified**: some part never ran.

Only offer a new option in `compatibility/stack.ts` once it has passed.

## What it found

The runs are not a formality: they found problems no unit test would, each fixed in the generator for every project after it:

- SQLite keeps no time zone, so a date-time read back differed from the one in the creation's answer (FastAPI): responses now read stored values, and treat dates without zone as UTC.
- A UUID key the server assigns had no default on PostgreSQL (FastAPI with SQLAlchemy).
- `lines` is a reserved word in MySQL and Hibernate did not quote it (Spring Boot with JPA).
- Timestamps kept nanoseconds in the answer and microseconds in the database (Spring Boot with JPA).
- Laravel's `RefreshDatabase` runs the migrations through Artisan, which needs Mockery in the tests (Laravel with Eloquent).
- Doctrine DBAL needs the PostgreSQL server version before it connects; `doctrine.yaml` now sets it (Symfony with Doctrine).
- Doctrine does not quote reserved words such as `lines` (MySQL): tables and columns are now quoted in the mapping (Symfony with Doctrine).
- The input classes listed their `use` statements before the enums they check were added, so a body with an enum failed with a 500 (Symfony).
- ASP.NET Core answered a body without `Content-Type` (415) with its own ProblemDetails: client errors now use the error format of the contract (ASP.NET Core).
- The MySQL provider of Entity Framework Core reads dates as `DateTime`, so reading a `DateOnly` failed with a 500: dates are converted for MySQL and MariaDB (ASP.NET Core with EF Core).
- Test files that recreate the schema at the same time on one database (NestJS with TypeORM): they now take turns.
