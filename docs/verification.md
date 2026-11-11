# Verification

Producing files is not proof that they work. A language, ORM and database combination will be offered as verified only after a project generated with it has been built and its tests have passed, with their own tools, in Docker, by the scripts of `verification/`.

No combination is verified yet: the generators are being written, starting with Python + SQLAlchemy 2 + PostgreSQL. The runners below come from Model2API and are kept for them.

## Runners

Each runner takes the folder of a generated project and, in a clean container:

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

Downloads and compiled dependencies are cached in Docker volumes, so later runs are faster.

Projects that need a database run with one: `runners/with-database.sh` starts PostgreSQL 16, MySQL 8.4 or MariaDB 11 on a private network, passes its address to the runner and removes both afterwards.

## What the tests will check

The tests are generated with the project and are the same the developer keeps:

- **Services**, with in-memory repositories: conversions between application models and entities, lookups, validation from the constraints, and domain errors.
- **Repositories**, against a real database created from the input schema: every query the schema allows, unique and foreign key checks, and generated columns.

The scenarios (an example, a stack and its options) and the script that writes their projects come back with the first generator.
