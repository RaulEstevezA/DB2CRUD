# Verification

Producing files is not proof that they work. A language, ORM and database combination will be offered as verified only after a project generated with it has been built and its tests have passed, with their own tools, in Docker, by the scripts of `verification/`.

Verified today, on PostgreSQL, MySQL, MariaDB and SQLite: Python + SQLAlchemy 2 (synchronous and asynchronous), Python + Django 5.2, TypeScript + TypeORM 0.3, TypeScript + Prisma 7, TypeScript + Drizzle 0.45, TypeScript + Sequelize 6 and Java 21 + JPA (Hibernate 7). The list the interface reads is `web/src/core/settings/verified.ts` (and its desktop copy), with the scenarios that proved each combination and their date. The runners of the other languages come from Model2API and are kept for the stacks still to write.

## Runners

Each runner takes the folder of a generated project and, in a clean container:

| Runner | Image | Steps |
|---|---|---|
| `runners/python.sh` | `python:3.12-slim` | Installs `requirements-dev.txt`, compiles every module, runs the project's tests with pytest (pytest-django for Django) |
| `runners/node.sh` | `node:24-alpine` | Installs the dependencies, checks the types (`tsc --noEmit`), builds, runs the project's tests with Vitest |
| `runners/java.sh` | `maven:3.9-eclipse-temurin-21` | Compiles and runs the project's tests with Maven (JUnit) |
| `runners/php.sh` | `php:8.5-cli` with the PostgreSQL and MySQL drivers and Composer, built once | Installs the dependencies with Composer, checks the syntax of every file (`php -l`), runs the project's tests with PHPUnit |
| `runners/dotnet.sh` | `mcr.microsoft.com/dotnet/sdk:10.0` | Restores the packages, builds the solution and runs the project's tests with xUnit (`dotnet test`) |
| `runners/kotlin.sh` | `gradle:9.8.2-jdk21` | Compiles and runs the project's tests with Gradle, and prints how many ran |
| `runners/rust.sh` | `rust:1.99.1` | Compiles the project with every warning treated as an error and runs its tests with Cargo (registry and compiled dependencies cached in Docker volumes), and prints how many ran |
| `runners/swift.sh` | `swift:6.4.2-noble` | Builds the project and its tests with the Swift Package Manager, fails on any warning of the project's own code, runs its Swift Testing suites (packages and compiled dependencies cached in a Docker volume), and prints how many ran |

Downloads and compiled dependencies are cached in Docker volumes, so later runs are faster.

Projects that need a database run with one: `runners/with-database.sh` starts PostgreSQL 16, MySQL 8.4 or MariaDB 11 on a private network, passes its address to the runner and removes the container, its volume and the network afterwards. SQLite runs inside the project's own container.

## What the tests check

The tests are generated with the project and are the same the developer keeps:

- **Services**, with in-memory repositories: conversions between application models and entities, lookups, validation from the constraints, and domain errors.
- **Repositories**, against a real database created from the entities: every query the schema allows, unique and foreign key checks, and generated columns.
- **The database itself**: one test fails when the tests did not run on the database `TEST_DATABASE_URL` names, so a green run proves which one it was.

The test database is created empty for every test. Most ORMs create it from their entities; with Prisma, a Vitest global setup asks Prisma for the SQL of the schema (`prisma migrate diff --from-empty`) once, and every test drops the tables and runs it; with Drizzle, the SQL comes from `drizzle-kit/api` in the same way. With JPA, one EntityManagerFactory is created from the entities and every test drops and creates the tables again (`SchemaManager`); Hibernate creates no foreign keys on SQLite, so there only the services check them. A Prisma schema, like Drizzle's tables, Sequelize's models and the JPA entities, is for one kind of database, so those projects on PostgreSQL, MySQL or MariaDB have no SQLite fallback: their database tests need `TEST_DATABASE_URL`.

## Scenarios

`verification/scenarios/index.mjs` lists the scenarios: an example schema, the settings that differ from the defaults and, for some, the decisions of the review taken the other way. Together they cover every option of every setting, on every database. `verification/run.sh [prefix]` writes their projects (`generate.mjs`, with the same core the web version runs) to `verification/.work/` and runs each one with its runner, with a database when it needs one.

The same scenarios are the shared outputs in `shared/test-cases/outputs/`: the desktop version must write exactly the same files.
